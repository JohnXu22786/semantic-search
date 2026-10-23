/**
 * SearchIndex: the engine's orchestration heart.
 *
 * Responsibilities:
 *   - full build (scan → chunk → tokenize → BM25 index → embeddings → persist)
 *   - incremental refresh (metadata diff by size+mtime; reindex only what changed)
 *   - single-file reindex (add/update/remove one path)
 *   - hybrid search (vector cosine + BM25, fused by RRF)
 *   - persistence round-trip via src/engine/persist.ts
 *   - graceful degradation to the local lexical provider when a configured
 *     remote provider is unavailable
 *
 * Chunk ids are stable monotonic integers; removal leaves no renumbering
 * because all collections are id-keyed maps (persistence packs them densely).
 *
 * Concurrency: public mutations and searches run through a single lock queue so
 * the lazy-build path (search → ensureReady) can never interleave with a
 * rebuild. Private helpers must NOT take the lock again (no re-entrancy).
 */

import { readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type {
  BuildResult,
  ChunkRecord,
  EmbeddingContext,
  EmbeddingProvider,
  EngineConfig,
  FileRecord,
  LoadResult,
  SearchHit,
  SearchResult,
  SearchStats,
} from './types.ts'
import { chunkText } from './chunker.ts'
import { languageForPath } from './languages.ts'
import { LexicalIndex } from './lexical.ts'
import {
  clearIndex,
  dataDirBytes,
  FORMAT_VERSION,
  hasPersisted,
  loadIndex,
  persistIndex,
  type LoadOutput,
  type PersistData,
} from './persist.ts'
import { createProvider, LexicalVectorProvider } from './provider.ts'
import { fuse, topByCosine, type RankedCandidate } from './retrieve.ts'
import { isBinaryContent, scanWorkspace, type ScannedFile } from './scanner.ts'
import { termFrequencies, tokenize } from './tokenizer.ts'

/** Minimal logger facade (dsh's ctx.logger satisfies it). */
export interface LogLike {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

const DEFAULT_LEGACY_DIM = 1024
const SNIPPET_CHARS = 500

export class SearchIndex {
  readonly config: EngineConfig
  private log: LogLike
  private provider: EmbeddingProvider
  private lexical = new LexicalIndex()
  private chunksById = new Map<number, ChunkRecord>()
  private chunkTerms = new Map<number, Map<string, number>>()
  private vectorsById = new Map<number, Float32Array>()
  private filesByRel = new Map<string, FileRecord>()
  private contentBytesByRel = new Map<string, number>()
  private fileIds = new Map<number, FileRecord>()
  private nextChunkId = 0
  private nextFileId = 0
  private builtAt: number | null = null
  private truncated = false
  private degraded = false
  private errors: string[] = []
  private initialized = false
  private loadTried = false
  private needsRefresh = false
  private forceFullRebuild = false
  private busy: Promise<unknown> = Promise.resolve()

  constructor(config: EngineConfig, log: LogLike = {}, resolveKey?: (signal?: AbortSignal) => Promise<string>) {
    this.config = config
    this.log = log
    this.provider = createProvider(config.provider, resolveKey)
  }

  /** True once the in-memory index has been built or loaded, including zero chunks. */
  get ready(): boolean {
    return this.builtAt !== null
  }

  get providerId(): string {
    return this.provider.id
  }

  get providerKind(): 'lexical' | 'openai' {
    return this.provider.kind
  }

  get dimension(): number {
    return this.provider.dimension
  }

  /** Queue a mutation/search so overlapping calls serialize. */
  private withLock<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('embedding aborted'))
    const run = this.busy.then(() => {
      if (signal?.aborted) throw new Error('embedding aborted')
      return task()
    })
    this.busy = run.catch(() => undefined)
    if (!signal) return run
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener('abort', onAbort)
      const onAbort = (): void => {
        cleanup()
        reject(new Error('embedding aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      run.then(
        (value) => { cleanup(); resolve(value) },
        (error: unknown) => { cleanup(); reject(error) },
      )
      if (signal.aborted) onAbort()
    })
  }

  // ---- Initialization --------------------------------------------------------

  /**
   * Attempt to load a persisted index (idempotent). Callers that prefer a lazy
   * first build instead rely on {@link search} → ensureReady.
   */
  async init(): Promise<LoadResult> {
    this.initialized = true
    if (this.loadTried) return this.stateLoadResult()
    return this.withLock(async () => {
      this.loadTried = true
      if (this.ready) return { status: 'loaded', meta: this.metaSnapshot() }
      if (this.forceFullRebuild) return { status: 'empty', meta: null }
      const result = await loadIndex(this.config.dataDir, this.expectedProvider())
      if (result.status === 'loaded' && result.data) {
        this.applyLoaded(result.data)
        return { status: 'loaded', meta: this.metaSnapshot() }
      }
      this.log.debug?.(`index load skipped: ${result.reason ?? result.status}`)
      return result
    })
  }

  private stateLoadResult(): LoadResult {
    if (this.ready) return { status: 'loaded', meta: this.metaSnapshot() }
    return { status: 'empty', meta: null }
  }

  /**
   * Lazily ensure an index is searchable, building one if none is loaded.
   * Must be called from within a {@link withLock} body (no re-entrancy).
   */
  private async ensureReadyInternal(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('embedding aborted')
    if (this.ready) {
      if (this.needsRefresh) {
        await this.refreshLoadedIndex(signal)
      }
      return
    }
    if (!this.initialized) {
      this.initialized = true
      this.loadTried = true
    }
    if (this.loadTried && !this.forceFullRebuild) {
      const result = await loadIndex(this.config.dataDir, this.expectedProvider())
      if (signal?.aborted) throw new Error('embedding aborted')
      if (result.status === 'loaded' && result.data) {
        this.applyLoaded(result.data)
        await this.refreshLoadedIndex(signal)
        return
      }
      if (result.status === 'stale') {
        const reason = result.reason ?? 'unknown'
        this.errors.push(`persisted index is stale (${reason}); rebuilding`)
        this.log.warn?.(`persisted index is stale: ${reason} — rebuilding`)
        await clearIndex(this.config.dataDir)
      }
    }
    try {
      await this.buildFull(signal)
    } catch (error) {
      this.invalidateState()
      throw error
    }
  }

  /** Build (full) or incrementally refresh the index. */
  build(mode: 'full' | 'refresh' = 'full', signal?: AbortSignal): Promise<BuildResult> {
    return this.withLock(async () => {
      if (signal?.aborted) throw new Error('embedding aborted')
      try {
        return await (mode === 'full' ? this.buildFull(signal) : this.refreshInternal(signal))
      } catch (error) {
        this.invalidateState()
        throw error
      }
    }, signal)
  }

  // ---- Full build ------------------------------------------------------------

  private async buildFull(signal?: AbortSignal): Promise<BuildResult> {
    if (signal?.aborted) throw new Error('embedding aborted')
    const t0 = Date.now()
    this.provider.resetInferredDimension?.()
    this.resetState()

    const scan = await scanWorkspace({
      root: this.config.root,
      include: this.config.include,
      ignore: [...this.config.ignore, this.dataDirName()],
      maxFileBytes: this.config.maxFileBytes,
      maxFiles: this.config.maxFiles,
      maxTotalBytes: this.config.maxTotalBytes,
      signal,
    })
    if (signal?.aborted) throw new Error('embedding aborted')
    this.errors.push(...scan.errors)
    this.truncated = scan.truncated

    let added = 0
    for (const file of scan.files) {
      if (signal?.aborted) throw new Error('embedding aborted')
      if (this.chunksById.size >= this.config.maxChunks) {
        this.truncated = true
        break
      }
      this.addFile(file)
      added++
    }
    this.lexical.refreshIdf()

    await this.embedAllChunks(signal)

    this.builtAt = Date.now()
    this.log.info?.(
      `index built: ${this.filesByRel.size} file(s), ${this.chunksById.size} chunk(s), ${this.lexical.terms} terms in ${Date.now() - t0}ms`,
    )
    if (this.config.autosave) await this.safePersist()
    if (signal?.aborted) throw new Error('embedding aborted')
    this.forceFullRebuild = false
    return this.result('full', added, 0, 0, 0)
  }

  private resetState(): void {
    this.lexical = new LexicalIndex()
    this.chunksById.clear()
    this.chunkTerms.clear()
    this.vectorsById.clear()
    this.filesByRel.clear()
    this.contentBytesByRel.clear()
    this.fileIds.clear()
    this.nextChunkId = 0
    this.nextFileId = 0
    this.builtAt = null
    this.truncated = false
    this.degraded = false
    this.errors = []
    this.needsRefresh = false
  }

  private invalidateState(): void {
    this.resetState()
    this.loadTried = true
    this.forceFullRebuild = true
  }

  private async refreshLoadedIndex(signal?: AbortSignal): Promise<void> {
    let mutated = false
    try {
      await this.refreshInternal(signal, () => { mutated = true })
    } catch (error) {
      if (mutated || !signal?.aborted) this.invalidateState()
      throw error
    }
  }

  // ---- Incremental refresh ----------------------------------------------------

  /**
   * Metadata-diff the workspace against the in-memory index and reindex only
   * files whose size, mtime, or detected language changed. Persisted records
   * retain the decoded byte count of the content currently held in the index.
   */
  private async refreshInternal(signal?: AbortSignal, onMutation?: () => void): Promise<BuildResult> {
    if (signal?.aborted) throw new Error('embedding aborted')
    if (!this.ready && this.builtAt === null) return this.buildFull(signal)
    const t0 = Date.now()
    const scan = await scanWorkspace({
      root: this.config.root,
      include: this.config.include,
      ignore: [...this.config.ignore, this.dataDirName()],
      maxFileBytes: this.config.maxFileBytes,
      maxFiles: this.config.maxFiles,
      maxTotalBytes: this.config.maxTotalBytes,
      readContent: false,
      signal,
    })
    if (signal?.aborted) throw new Error('embedding aborted')
    for (const error of scan.errors) {
      if (!this.errors.includes(error)) this.errors.push(error)
    }
    const scanIncomplete = scan.truncated
      || scan.errors.length > 0
      || (scan.skipped.get('too-large') ?? 0) > 0
    const retainedBinary = scan.skippedBinary.some((rel) => this.filesByRel.has(rel))
    this.truncated = scanIncomplete || retainedBinary

    let added = 0
    let updated = 0
    let removed = 0
    let unchanged = 0
    const seen = new Set<string>(scan.skippedBinary)
    const changed: ScannedFile[] = []

    for (const meta of scan.files) {
      if (signal?.aborted) throw new Error('embedding aborted')
      seen.add(meta.rel)
      const existing = this.filesByRel.get(meta.rel)
      if (existing && existing.size === meta.size && existing.mtimeMs === meta.mtimeMs && existing.language === meta.language) {
        unchanged++
        continue
      }
      changed.push(meta)
    }

    if (!scanIncomplete) {
      for (const rel of this.filesByRel.keys()) {
        if (signal?.aborted) throw new Error('embedding aborted')
        if (!seen.has(rel)) {
          onMutation?.()
          this.removeFileByRel(rel)
          removed++
        }
      }
    }

    let totalBytes = 0
    let totalBytesKnown = true
    const bytesByRel = new Map<string, number>()
    for (const record of this.filesByRel.values()) {
      if (signal?.aborted) throw new Error('embedding aborted')
      const contentBytes = this.contentBytesByRel.get(record.rel)
      if (contentBytes === undefined) {
        totalBytesKnown = false
        continue
      }
      bytesByRel.set(record.rel, contentBytes)
      totalBytes += contentBytes
    }
    if (!totalBytesKnown) {
      totalBytes = Number.POSITIVE_INFINITY
      this.truncated = true
    }

    let hadReadFailure = false
    const reindexedRels: string[] = []
    for (const meta of changed) {
      if (signal?.aborted) throw new Error('embedding aborted')
      const existingRecord = this.filesByRel.get(meta.rel)
      const existed = existingRecord !== undefined
      const previousBytes = bytesByRel.get(meta.rel) ?? 0
      let content: string
      try {
        content = await readFile(meta.path, { encoding: 'utf8', signal })
      } catch (error) {
        if (signal?.aborted) throw new Error('embedding aborted')
        const readError = `cannot read ${meta.rel}: ${error instanceof Error ? error.message : String(error)}`
        if (!this.errors.includes(readError)) this.errors.push(readError)
        this.truncated = true
        hadReadFailure = true
        continue
      }
      if (isBinaryContent(content)) {
        if (existed) this.truncated = true
        continue
      }
      const contentBytes = Buffer.byteLength(content, 'utf8')
      const nextTotalBytes = totalBytes - previousBytes + contentBytes
      if (nextTotalBytes > this.config.maxTotalBytes) {
        this.truncated = true
        break
      }
      totalBytes = nextTotalBytes
      const availableChunks = this.chunksById.size - (existingRecord?.chunkIds.length ?? 0)
      if (availableChunks >= this.config.maxChunks) {
        this.truncated = true
        break
      }
      const candidates = chunkText(content, languageForPath(meta.path), { maxLines: this.config.maxLinesPerChunk })
      if (availableChunks + candidates.length > this.config.maxChunks) {
        this.truncated = true
        break
      }
      if (existed) onMutation?.()
      this.removeFileByRel(meta.rel)
      if (!existed) onMutation?.()
      this.addFile({ ...meta, content }, candidates)
      reindexedRels.push(meta.rel)
      bytesByRel.set(meta.rel, contentBytes)
      if (existed) updated++
      else added++
    }

    if (totalBytes > this.config.maxTotalBytes) this.truncated = true
    if (reindexedRels.length > 0 || removed > 0) {
      this.lexical.refreshIdf()
      // Lexical vectors use corpus IDF, so recompute every row against the
      // final IDF. Other providers only need their changed rows refreshed.
      await this.reembed(reindexedRels, signal)
    }
    if (this.chunksById.size === 0 && this.filesByRel.size === 0) {
      const refreshTruncated = this.truncated
      this.resetState()
      this.truncated = refreshTruncated
    }

    this.builtAt = Date.now()
    this.needsRefresh = hadReadFailure || scan.errors.length > 0
    this.log.info?.(
      `incremental index refresh: +${added} ~${updated} -${removed} =${unchanged} (${this.chunksById.size} chunk(s)) in ${Date.now() - t0}ms`,
    )
    if (this.config.autosave) await this.safePersist()
    if (signal?.aborted) throw new Error('embedding aborted')
    return this.result('incremental', added, updated, removed, unchanged)
  }

  /** Add, update, or remove one file by its absolute path. */
  async reindexFile(path: string, signal?: AbortSignal): Promise<BuildResult> {
    return this.withLock(async () => {
      if (signal?.aborted) throw new Error('embedding aborted')
      let mutated = false
      try {
        await this.ensureReadyInternal(signal)
        if (signal?.aborted) throw new Error('embedding aborted')
        const rel = this.toRel(path)
        const existed = this.filesByRel.has(rel)
        let replaced = false
        let idfRefreshed = false
        mutated = true
        this.removeFileByRel(rel)
        try {
          const [st, content] = await Promise.all([
            stat(path),
            readFile(path, { encoding: 'utf8', signal }),
          ])
          if (signal?.aborted) throw new Error('embedding aborted')
          if (isBinaryContent(content)) {
            this.lexical.refreshIdf()
            idfRefreshed = true
            await this.reembed([], signal)
          } else {
            const lang = languageForPath(path)
            this.addFile({
              path,
              rel,
              language: lang?.name ?? 'text',
              size: st.size,
              mtimeMs: st.mtimeMs,
              content,
            })
            this.lexical.refreshIdf()
            idfRefreshed = true
            await this.reembed([rel], signal)
            replaced = true
          }
        } catch (error) {
          if (signal?.aborted) throw error
          if (existed && !idfRefreshed) {
            // The old record was removed before reading the replacement. Keep
            // surviving lexical vectors aligned even when the read fails.
            this.lexical.refreshIdf()
            await this.reembed([], signal)
          }
          this.errors.push(`reindex ${rel} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (signal?.aborted) throw new Error('embedding aborted')
        if (this.config.autosave) await this.safePersist()
        if (signal?.aborted) throw new Error('embedding aborted')
        if (replaced) return this.result('incremental', existed ? 0 : 1, existed ? 1 : 0, 0, 0)
        return this.result('incremental', 0, 0, 1, 0)
      } catch (error) {
        if (mutated && signal?.aborted) {
          this.invalidateState()
        }
        throw error
      }
    }, signal)
  }

  /** Drop a file from the index by absolute path. */
  async removeFile(path: string): Promise<void> {
    await this.withLock(async () => {
      await this.ensureReadyInternal()
      const rel = this.toRel(path)
      const existed = this.filesByRel.has(rel)
      this.removeFileByRel(rel)
      if (existed) {
        this.lexical.refreshIdf()
        await this.reembed([])
      }
      if (this.config.autosave && (this.chunksById.size > 0 || existed)) await this.safePersist()
    })
  }

  // ---- Internal mutation primitives -------------------------------------------

  private dataDirName(): string {
    const parts = this.config.dataDir.replace(/[\\/]+$/, '').split(/[\\/]/)
    return parts[parts.length - 1] ?? this.config.dataDir
  }

  private expectedProvider(): { providerId: string; dimension: number } {
    return { providerId: this.provider.id, dimension: this.provider.dimension }
  }

  private metaSnapshot() {
    return {
      version: FORMAT_VERSION,
      providerId: this.provider.id,
      providerKind: this.provider.kind,
      dimension: this.provider.dimension,
      root: this.config.root,
      builtAt: this.builtAt ?? 0,
      truncated: this.truncated,
    }
  }

  private toRel(abs: string): string {
    return relative(this.config.root, abs).split(sep).join('/')
  }

  private joinRoot(rel: string): string {
    return join(this.config.root, rel)
  }

  private applyLoaded(data: LoadOutput): void {
    // An empty auto-dimension index may contain the legacy fallback, not an inferred vector width.
    if (data.chunks.length > 0) this.provider.restoreDimension?.(data.meta.dimension)
    this.contentBytesByRel.clear()
    for (const chunk of data.chunks) this.chunksById.set(chunk.id, chunk)
    for (const t of data.terms) this.chunkTerms.set(t.chunk, new Map(t.terms))
    for (const file of data.files) {
      this.filesByRel.set(file.rel, file)
      this.fileIds.set(file.id, file)
      if (Number.isSafeInteger(file.contentBytes) && file.contentBytes >= 0) {
        this.contentBytesByRel.set(file.rel, file.contentBytes)
      }
    }
    this.lexical = new LexicalIndex()
    for (const t of data.terms) {
      const tf = this.chunkTerms.get(t.chunk)
      if (tf) this.lexical.put(t.chunk, tf)
    }
    this.lexical.refreshIdf()
    data.chunks.forEach((chunk, index) => {
      const vec = data.vectors[index]
      if (vec) this.vectorsById.set(chunk.id, vec)
    })
    this.nextChunkId = data.chunks.length > 0 ? Math.max(...data.chunks.map((c) => c.id)) + 1 : 0
    this.nextFileId = data.files.length > 0 ? Math.max(...data.files.map((f) => f.id)) + 1 : 0
    this.builtAt = data.meta.builtAt
    this.truncated = data.meta.truncated
    this.needsRefresh = true
  }

  /** Chunk + tokenize + index one scanned file (embeddings computed separately). */
  private addFile(
    file: ScannedFile,
    candidates = chunkText(file.content, languageForPath(file.path), { maxLines: this.config.maxLinesPerChunk }),
  ): void {
    const fileId = this.nextFileId++
    const contentBytes = Buffer.byteLength(file.content, 'utf8')
    const record: FileRecord = {
      id: fileId,
      rel: file.rel,
      path: file.path,
      size: file.size,
      contentBytes,
      mtimeMs: file.mtimeMs,
      language: file.language,
      chunkIds: [],
    }
    this.filesByRel.set(file.rel, record)
    this.contentBytesByRel.set(file.rel, contentBytes)
    this.fileIds.set(fileId, record)
    for (const candidate of candidates) {
      const chunkId = this.nextChunkId++
      const chunk: ChunkRecord = {
        id: chunkId,
        fileId,
        rel: file.rel,
        language: file.language,
        symbol: candidate.symbol,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        content: candidate.content,
        summary: candidate.summary,
      }
      this.chunksById.set(chunkId, chunk)
      const tf = termFrequencies(candidate.content, this.config.nGram)
      this.chunkTerms.set(chunkId, tf)
      this.lexical.put(chunkId, tf)
      record.chunkIds.push(chunkId)
    }
  }

  private removeFileByRel(rel: string): void {
    const record = this.filesByRel.get(rel)
    this.contentBytesByRel.delete(rel)
    if (!record) return
    for (const chunkId of record.chunkIds) {
      const tf = this.chunkTerms.get(chunkId)
      if (tf) this.lexical.remove(chunkId, tf)
      this.chunkTerms.delete(chunkId)
      this.vectorsById.delete(chunkId)
      this.chunksById.delete(chunkId)
    }
    this.filesByRel.delete(rel)
    this.fileIds.delete(record.id)
  }

  /** Embed every chunk using the current IDF table. */
  private async embedAllChunks(signal?: AbortSignal): Promise<void> {
    const ordered = [...this.chunksById.keys()].sort((a, b) => a - b)
    if (ordered.length === 0) return
    const texts = ordered.map((id) => this.chunksById.get(id)!.content)
    const rows = await this.embedSafe(texts, signal)
    ordered.forEach((id, index) => {
      const row = rows[index]
      if (row) this.vectorsById.set(id, row)
    })
  }

  /** Recompute vectors after an incremental change using the final corpus IDF. */
  private async reembed(rels: string[], signal?: AbortSignal): Promise<void> {
    if (this.provider.kind === 'lexical') {
      await this.embedAllChunks(signal)
      return
    }
    if (rels.length === 0) return
    const wanted = new Set(rels)
    const ordered = [...this.chunksById.keys()]
      .sort((a, b) => a - b)
      .filter((id) => wanted.has(this.chunksById.get(id)!.rel))
    if (ordered.length === 0) return
    const provider = this.provider
    const texts = ordered.map((id) => this.chunksById.get(id)!.content)
    const rows = await this.embedSafe(texts, signal)
    if (this.provider !== provider) {
      await this.embedAllChunks(signal)
      return
    }
    ordered.forEach((id, index) => {
      const row = rows[index]
      if (row) this.vectorsById.set(id, row)
    })
  }

  /** Embed with graceful degradation to the local lexical provider. */
  private async embedSafe(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const ctx: EmbeddingContext = { idf: this.lexical.idfMap, ...(signal ? { signal } : {}) }
    try {
      return await this.provider.embed(texts, ctx)
    } catch (error) {
      if (signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (this.config.allowFallback && !this.provider.local) {
        this.errors.push(`embedding provider unavailable (${message}); switched to local lexical provider`)
        this.log.warn?.(`embedding provider unavailable (${message}); switched to local lexical provider`)
        this.provider = new LexicalVectorProvider(this.fallbackDimension())
        this.degraded = true
        return this.provider.embed(texts, ctx)
      }
      this.errors.push(`embedding failed: ${message}`)
      throw new Error(`embedding failed: ${message}`)
    }
  }

  private fallbackDimension(): number {
    switch (this.config.provider.kind) {
      case 'lexical':
        return this.config.provider.dimension
      case 'openai':
        return DEFAULT_LEGACY_DIM
    }
  }

  // ---- Search -----------------------------------------------------------------

  /**
   * Hybrid search: vector cosine + BM25 fused with RRF.
   * @param query   the natural-language or code query
   * @param options optional topK override and cancellation signal
   */
  async search(query: string, options?: { topK?: number; signal?: AbortSignal }): Promise<SearchResult> {
    if (options?.signal?.aborted) throw new Error('search aborted')
    const text = String(query ?? '').trim()
    if (text.length === 0) throw new Error('search requires a non-empty query')
    return this.withLock(async () => {
      const t0 = Date.now()

      await this.ensureReadyInternal(options?.signal)

      const topK = Math.max(1, Math.floor(options?.topK ?? this.config.topK))
      const terms = [...new Set(tokenize(text, this.config.nGram))]

      // Vector channel.
      let vectorCands: RankedCandidate[] = []
      let degradedQuery = false
      if (this.vectorsById.size > 0) {
        if (this.provider.local) {
          const qvec = (await this.embedSafe([text], options?.signal))[0]!
          vectorCands = topByCosine(this.vectorsById.entries(), qvec, this.config.vectorK)
        } else {
          try {
            const qvec = (await this.provider.embed([text], { idf: this.lexical.idfMap, signal: options?.signal }))[0]!
            vectorCands = topByCosine(this.vectorsById.entries(), qvec, this.config.vectorK)
          } catch (error) {
            if (options?.signal?.aborted) throw error
            degradedQuery = true
            this.log.warn?.('query embedding failed; falling back to lexical-only search')
          }
        }
      }

      // Lexical channel.
      const lexicalCands: RankedCandidate[] =
        terms.length > 0 ? this.lexical.top(terms, this.config.vectorK).map((s) => ({ id: s.chunk, score: s.score })) : []

      const fused = fuse(vectorCands, lexicalCands, { rrfK: this.config.rrfK, topK })
      const hits: SearchHit[] = []
      for (const cand of fused) {
        const chunk = this.chunksById.get(cand.id)
        if (!chunk) continue
        hits.push({
          chunkId: cand.id,
          file: chunk.rel,
          path: this.fileById(chunk.fileId)?.path ?? this.joinRoot(chunk.rel),
          language: chunk.language,
          symbol: chunk.symbol,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          snippet: makeSnippet(chunk.content),
          summary: chunk.summary,
          score: cand.score,
          vectorScore: cand.vectorScore,
          lexicalScore: cand.lexicalScore,
        })
      }

      return {
        query: text,
        degraded: this.degraded || degradedQuery,
        providerId: this.provider.id,
        tookMs: Date.now() - t0,
        count: hits.length,
        hits,
      }
    }, options?.signal)
  }

  private fileById(id: number): FileRecord | undefined {
    return this.fileIds.get(id)
  }

  // ---- Stats & persistence -----------------------------------------------------

  /** Current index statistics (async: reads on-disk size best-effort). */
  async stats(): Promise<SearchStats> {
    const bytes = await dataDirBytes(this.config.dataDir)
    return {
      root: this.config.root,
      dataDir: this.config.dataDir,
      providerId: this.provider.id,
      providerKind: this.provider.kind,
      dimension: this.provider.dimension,
      files: this.filesByRel.size,
      chunks: this.chunksById.size,
      terms: this.lexical.terms,
      bytes,
      builtAt: this.builtAt,
      truncated: this.truncated,
      degraded: this.degraded,
      errors: [...this.errors],
    }
  }

  async hasPersistedIndex(): Promise<boolean> {
    return hasPersisted(this.config.dataDir)
  }

  private async safePersist(): Promise<void> {
    try {
      await this.persist()
    } catch (error) {
      const msg = `persist failed: ${error instanceof Error ? error.message : String(error)}`
      this.errors.push(msg)
      // Surface persist failures through the logger as well: callers that
      // never read the errors array (e.g. the CLI) would otherwise miss a
      // silent persist failure that discards a long build while the on-disk
      // index stays unchanged.
      this.log.error?.(msg)
    }
  }

  /** Persist the in-memory index (atomic JSON + binary vectors). */
  async persist(): Promise<void> {
    const ordered = [...this.chunksById.keys()].sort((a, b) => a - b)
    if (ordered.length > 0 && this.provider.dimension <= 0) {
      throw new Error('cannot persist a non-empty index before the embedding dimension is known')
    }
    const dim = this.provider.dimension > 0 ? this.provider.dimension : DEFAULT_LEGACY_DIM
    const chunks = ordered.map((id) => this.chunksById.get(id)!)
    const vectors = new Float32Array(dim * ordered.length)
    ordered.forEach((id, index) => {
      const vec = this.vectorsById.get(id)
      if (vec) vectors.set(vec.subarray(0, Math.min(vec.length, dim)), index * dim)
    })
    const terms: PersistData['terms'] = ordered.map((id) => ({
      chunk: id,
      terms: [...(this.chunkTerms.get(id)?.entries() ?? [])],
    }))
    await persistIndex(
      this.config.dataDir,
      {
        meta: this.metaSnapshot(),
        files: [...this.filesByRel.values()],
        chunks,
        terms,
        avgLen: this.lexical.avgLen,
      },
      vectors,
    )
  }

  private result(mode: BuildResult['mode'], added: number, updated: number, removed: number, unchanged: number): BuildResult {
    return {
      mode,
      added,
      updated,
      removed,
      unchanged,
      files: this.filesByRel.size,
      chunks: this.chunksById.size,
      truncated: this.truncated,
      errors: [...this.errors],
    }
  }
}

/** Build a readable snippet for a hit from the chunk content. */
export function makeSnippet(content: string, maxChars = SNIPPET_CHARS): string {
  const lines = content.split('\n').map((line) => line.trim())
  let out = ''
  for (const line of lines) {
    if (line.length === 0) continue
    const next = out.length === 0 ? line : `${out}\n${line}`
    if (out.length > 0 && next.length > maxChars) break
    out = next
  }
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd() + '…'
  return out
}

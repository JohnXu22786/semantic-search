/**
 * JSON + binary persistence for the search index.
 *
 * Format kept intentionally simple and inspectable:
 *   {dataDir}/index.json   – metadata, file/chunk records, per-chunk term maps
 *   {dataDir}/vectors.bin  – raw little-endian Float32 matrix, `dimension * chunks`
 *
 * At every provider/dimension change the persisted index is considered
 * stale (the on-disk vectors would no longer be comparable) and callers must
 * rebuild. Writes are atomic (temp file + rename).
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  ChunkRecord,
  FileRecord,
  LoadResult,
  PersistMeta,
} from './types.ts'

// Version 2 invalidates indexes whose lexical document vectors were embedded
// before incremental IDF changes re-embedded the full corpus.
export const FORMAT_VERSION = 2

export const INDEX_FILE = 'index.json'
export const VECTORS_FILE = 'vectors.bin'

export interface PersistTerms {
  chunk: number
  terms: Array<[string, number]>
}

export interface PersistData {
  meta: PersistMeta
  files: FileRecord[]
  chunks: ChunkRecord[]
  terms: PersistTerms[]
  avgLen: number
}

export interface LoadOutput {
  meta: PersistMeta
  files: FileRecord[]
  chunks: ChunkRecord[]
  terms: PersistTerms[]
  avgLen: number
  vectors: Float32Array[]
}

export interface ExpectedProvider {
  providerId: string
  dimension: number
}

function tmpPath(dir: string, name: string): string {
  return join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`)
}

/** Write a JSON payload atomically (temp file in the same directory + rename). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const parent = dirname(file)
  await mkdir(parent, { recursive: true })
  const tmp = tmpPath(parent, basename(file))
  await writeFile(tmp, JSON.stringify(value), 'utf8')
  await rename(tmp, file)
}

/**
 * Persist the whole index. `vectors` is the flat Float32Array of
 * `numChunks * dimension` cells (row-major: chunk-major).
 */
export async function persistIndex(
  dir: string,
  data: PersistData,
  vectors: Float32Array,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(join(dir, INDEX_FILE), data)
  const buf = Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
  const tmp = tmpPath(dir, VECTORS_FILE)
  await writeFile(tmp, buf)
  await rename(tmp, join(dir, VECTORS_FILE))
}

/** Total size of the persisted index directory (best-effort). */
export async function dataDirBytes(dir: string): Promise<number> {
  let total = 0
  try {
    for (const entry of await readdir(dir)) {
      const st = await stat(join(dir, entry))
      if (st.isFile()) total += st.size
    }
  } catch {
    return 0
  }
  return total
}

/** True when the index directory looks non-empty (any artifact present). */
export async function hasPersisted(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, INDEX_FILE))
    return true
  } catch {
    return false
  }
}

/**
 * Load the persisted index. Returns `status: 'stale'` with a reason when the
 * metadata is absent (empty), outdated (format version), or incompatible with
 * the expected provider (dimension/id changed).
 */
export async function loadIndex(
  dir: string,
  expected: ExpectedProvider,
): Promise<LoadResult & { data?: LoadOutput }> {
  try {
    const [jsonText, vecBuf] = await Promise.all([
      readFile(join(dir, INDEX_FILE), 'utf8'),
      readFile(join(dir, VECTORS_FILE)),
    ])
    const parsed = JSON.parse(jsonText) as unknown
    if (typeof parsed !== 'object' || parsed === null || !('meta' in parsed) || !('chunks' in parsed)) {
      return { status: 'stale', meta: null, reason: 'index.json is not a valid semantic-search index' }
    }
    const data = parsed as PersistData
    if (data.meta.version !== FORMAT_VERSION) {
      return { status: 'stale', meta: data.meta, reason: `index format v${data.meta.version} is not supported (need v${FORMAT_VERSION})` }
    }
    if (data.meta.providerId !== expected.providerId) {
      return { status: 'stale', meta: data.meta, reason: `provider changed (${data.meta.providerId} → ${expected.providerId}); rebuild required` }
    }
    // A configured dimension of 0 means "auto-infer from the endpoint", so it
    // cannot be verified until after a probe; only enforce equality when known.
    if (expected.dimension > 0 && data.meta.dimension !== expected.dimension) {
      return { status: 'stale', meta: data.meta, reason: `embedding dimension changed (${data.meta.dimension} → ${expected.dimension}); rebuild required` }
    }
    const dim = data.meta.dimension
    if (dim < 0 || (dim === 0 && data.chunks.length > 0)) {
      return { status: 'stale', meta: data.meta, reason: 'persisted index has an invalid dimension' }
    }
    const expectedCells = data.chunks.length * dim
    if (vecBuf.byteLength % 4 !== 0 || (expectedCells > 0 && vecBuf.byteLength === 0)) {
      return { status: 'stale', meta: data.meta, reason: 'vectors.bin is empty or corrupted' }
    }
    const flat = new Float32Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength / 4)
    const cells = flat.length
    if (cells !== expectedCells) {
      return { status: 'stale', meta: data.meta, reason: `vectors.bin (${cells} cells) does not match chunks (${data.chunks.length} × ${dim} = ${expectedCells}); rebuild required` }
    }
    const vectors: Float32Array[] = []
    for (let i = 0; i < data.chunks.length; i++) {
      vectors.push(flat.subarray(i * dim, (i + 1) * dim))
    }
    return {
      status: 'loaded',
      meta: data.meta,
      data: {
        meta: data.meta,
        files: data.files,
        chunks: data.chunks,
        terms: data.terms,
        avgLen: data.avgLen,
        vectors,
      },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'empty', meta: null }
    }
    return {
      status: 'stale',
      meta: null,
      reason: `cannot load index: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Remove the persisted index files (for a full `--force` rebuild). */
export async function clearIndex(dir: string): Promise<void> {
  await rm(join(dir, INDEX_FILE), { force: true })
  await rm(join(dir, VECTORS_FILE), { force: true })
}

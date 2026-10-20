/**
 * Embedding providers.
 *
 *  - {@link LexicalVectorProvider}  — the built-in, dependency-free local
 *    provider. Each text becomes a fixed-dimension vector via feature hashing
 *    of its terms (camel-case aware + CJK n-gram tokenizer), weighted by
 *    log-sublinear TF × IDF. Deterministic, no network, no model download.
 *  - {@link OpenAICompatProvider}  — any `POST {baseUrl}/embeddings`
 *    OpenAI-compatible endpoint. Used when a real semantic embedding model is
 *    configured (DeepSeek's own API has no embedding endpoint, so point this
 *    at any provider that does; see README).
 *
 *  Query and document text go through the same provider, so cosine similarity
 *  in the index (whose vectors were produced with corpus IDF) is meaningful.
 */

import type { EmbeddingProvider, ResolvedProviderConfig } from './types.ts'
import { termFrequencies, tokenize } from './tokenizer.ts'

/** Base error for any embedding failure (transport, auth, parse). */
export class EmbeddingError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

// ---- Feature hashing --------------------------------------------------------

/** FNV-1a 32-bit hash with a seed salt; returns an unsigned 32-bit int. */
function fnv1a(text: string, seed: number): number {
  let hash = 0x811c9dc5 ^ seed
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** L2-normalize rows in place; zero vectors stay zero. */
export function normalizeRows(rows: Float32Array[]): Float32Array[] {
  for (const row of rows) {
    let sum = 0
    for (let i = 0; i < row.length; i++) sum += row[i]! * row[i]!
    if (sum === 0) continue
    const norm = Math.sqrt(sum)
    for (let i = 0; i < row.length; i++) row[i] = row[i]! / norm
  }
  return rows
}

/** Cosine similarity between two equal-length vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!
  return dot
}

// ---- Local lexical provider -------------------------------------------------

/**
 * Feature-hashed TF-IDF vectors computed entirely locally.
 *
 * Dimension and footprint: each vector is `dimension` Float32 values. With the
 * default 4096 that is 16 KiB per chunk in the raw binary store (see README for
 * sizing guidance); 1024 → 4 KiB. Larger dimensions reduce hash collisions at
 * the cost of more storage.
 */
export class LexicalVectorProvider implements EmbeddingProvider {
  readonly kind = 'lexical' as const
  readonly local = true
  readonly id = 'lexical'
  readonly dimension: number

  constructor(dimension = 4096) {
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error(`lexical provider: dimension must be a positive integer, got ${dimension}`)
    }
    this.dimension = dimension
  }

  embed(texts: string[], ctx?: { idf?: ReadonlyMap<string, number>; signal?: AbortSignal }): Promise<Float32Array[]> {
    if (ctx?.signal?.aborted) return Promise.reject(new EmbeddingError('embedding aborted'))
    const rows: Float32Array[] = []
    for (const text of texts) {
      rows.push(this.embedOne(text, ctx?.idf))
    }
    return Promise.resolve(normalizeRows(rows))
  }

  private embedOne(text: string, idf?: ReadonlyMap<string, number>): Float32Array {
    const vec = new Float32Array(this.dimension)
    const tf = termFrequencies(text)
    for (const [term, freq] of tf) {
      const weight = (1 + Math.log(freq)) * (idf?.get(term) ?? Math.log(1 + 1))
      if (weight === 0) continue
      const h1 = fnv1a(term, 0x9e3779b1)
      const h2 = fnv1a(term, 0x85ebca6b)
      const idx = h1 % this.dimension
      const sign = (h2 & 1) === 0 ? 1 : -1
      vec[idx]! += sign * weight
    }
    return vec
  }
}

// ---- OpenAI-compatible provider --------------------------------------------

export interface OpenAICompatOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** 0 = infer from the endpoint's first response. */
  dimension: number
  timeoutMs: number
  maxCharsPerText: number
  batchSize: number
  /**
   * Per-operation API key resolution (e.g. through the host's credential
   * service). Takes precedence over the static `apiKey`, so key rotation
   * applies without recreating the provider.
   */
  resolveKey?: (signal?: AbortSignal) => Promise<string>
}

const API_VERSION_ERROR_PREFIX = 'embedding request failed'

class EmbeddingDimensionError extends EmbeddingError {
  constructor(expected: number, actual: number) {
    super(`${API_VERSION_ERROR_PREFIX}: embedding dimension mismatch (expected ${expected}, got ${actual})`)
  }
}

function resolveKeyWithTimeout(
  resolveKey: (signal?: AbortSignal) => Promise<string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(new EmbeddingError('embedding aborted'))

  let rejectAbort!: (reason: EmbeddingError) => void
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const controller = new AbortController()
  const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const onAbort = (): void => rejectAbort(new EmbeddingError('embedding aborted'))
  operationSignal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (operationSignal.aborted) onAbort()

  return Promise.race([Promise.resolve().then(() => resolveKey(operationSignal)), aborted]).finally(() => {
    clearTimeout(timer)
    operationSignal.removeEventListener('abort', onAbort)
    controller.abort()
  })
}

export class OpenAICompatProvider implements EmbeddingProvider {
  readonly kind = 'openai' as const
  readonly local = false
  readonly id = 'openai'

  private readonly options: OpenAICompatOptions
  private dynamic: number

  constructor(options: OpenAICompatOptions) {
    this.options = options
    this.dynamic = options.dimension
  }

  /** Configured dimension, or the inferred one once the endpoint answered. */
  get dimension(): number {
    return this.dynamic
  }

  restoreDimension(dimension: number): void {
    if (this.dynamic !== 0) return
    if (Number.isInteger(dimension) && dimension > 0) this.dynamic = dimension
  }

  resetInferredDimension(): void {
    if (this.options.dimension === 0) this.dynamic = 0
  }

  private acceptRows(rows: readonly Float32Array[], currentDimension: number): number {
    if (rows.length === 0) return currentDimension
    const dimension = currentDimension || rows[0]!.length
    for (const row of rows) {
      if (row.length !== dimension) throw new EmbeddingDimensionError(dimension, row.length)
    }
    return dimension
  }

  async embed(texts: string[], ctx?: { signal?: AbortSignal }): Promise<Float32Array[]> {
    if (ctx?.signal?.aborted) throw new EmbeddingError('embedding aborted')
    const baseUrl = this.options.baseUrl.replace(/\/+$/, '')
    const url = `${baseUrl}/embeddings`
    // Resolve the key per operation when a resolver is provided (allows
    // rotation without restart); otherwise fall back to the static key.
    const resolveKey = this.options.resolveKey
    const key = (typeof resolveKey === 'function'
      ? String((await resolveKeyWithTimeout(resolveKey, this.options.timeoutMs, ctx?.signal)) ?? '')
      : this.options.apiKey).trim()
    if (key.length === 0) {
      throw new EmbeddingError('openai provider: no API key configured (set provider.apiKey or the env var)')
    }

    const rows: Float32Array[] = []
    let inferredDimension = this.dynamic
    const { batchSize, maxCharsPerText, model, timeoutMs } = this.options
    for (let i = 0; i < texts.length; i += batchSize) {
      const deadline = Date.now() + timeoutMs
      if (ctx?.signal?.aborted) throw new EmbeddingError('embedding aborted')
      const batch = texts.slice(i, i + batchSize).map((t) => t.slice(0, maxCharsPerText))
      const body = JSON.stringify({ model, input: batch })

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onOuter = (): void => controller.abort()
      ctx?.signal?.addEventListener('abort', onOuter, { once: true })

      let response: Response
      let detail = ''
      let json: unknown = undefined
      let jsonError: unknown = undefined
      let jsonReadFailed = false
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`,
          },
          body,
          signal: controller.signal,
        })
        if (!response.ok) {
          try {
            detail = (await response.text()).slice(0, 400)
          } catch (error) {
            if (ctx?.signal?.aborted || controller.signal.aborted) throw error
            /* best effort */
          }
        } else {
          try {
            json = await response.json()
          } catch (error) {
            if (ctx?.signal?.aborted || controller.signal.aborted) throw error
            jsonError = error
            jsonReadFailed = true
          }
        }
      } catch (error) {
        const aborted = ctx?.signal?.aborted || controller.signal.aborted
        throw new EmbeddingError(
          aborted
            ? 'embedding aborted'
            : `${API_VERSION_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
          error,
        )
      } finally {
        clearTimeout(timer)
        ctx?.signal?.removeEventListener('abort', onOuter)
      }
      if (ctx?.signal?.aborted || controller.signal.aborted) throw new EmbeddingError('embedding aborted')

      if (!response.ok) {
        const batchError = new EmbeddingError(`${API_VERSION_ERROR_PREFIX}: HTTP ${response.status} ${response.statusText} ${detail}`.trim())
        // A batch-level HTTP 400 (e.g. "parameter error" codes) can be
        // triggered by a single rejected item — commonly one oversized or
        // otherwise invalid chunk. Retry the batch item-by-item so one bad
        // chunk no longer fails the whole embed call and drives the caller
        // into permanent lexical fallback after the first boot build. Good
        // items keep their vectors; bad items get a zero-vector placeholder
        // so row alignment is preserved (search still ranks them through
        // the lexical channel). All retries share the original batch deadline.
        if (response.status === 400 && batch.length > 1) {
          const salvaged: Array<Float32Array | null> = []
          let anyOk = false
          for (let itemIndex = 0; itemIndex < batch.length; itemIndex++) {
            if (ctx?.signal?.aborted) throw new EmbeddingError('embedding aborted')
            const remainingMs = deadline - Date.now()
            if (remainingMs <= 0) {
              salvaged.push(...new Array<Float32Array | null>(batch.length - itemIndex).fill(null))
              break
            }
            try {
              const c2 = new AbortController()
              const t2 = setTimeout(() => c2.abort(), remainingMs)
              try {
                const r2 = await fetch(url, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                  body: JSON.stringify({ model, input: [batch[itemIndex]!] }),
                  signal: AbortSignal.any([c2.signal, ...(ctx?.signal ? [ctx.signal] : [])]),
                })
                if (!r2.ok) {
                  c2.abort()
                  throw new Error('single-item embedding request failed')
                }
                const single = extractEmbeddings(await r2.json(), 1)
                inferredDimension = this.acceptRows(single, inferredDimension)
                salvaged.push(...single)
                anyOk = true
              } finally {
                clearTimeout(t2)
              }
            } catch (error) {
              if (ctx?.signal?.aborted) throw new EmbeddingError('embedding aborted', error)
              if (error instanceof EmbeddingDimensionError) throw error
              salvaged.push(null) // placeholder until the dimension is known
            }
          }
          if (ctx?.signal?.aborted) throw new EmbeddingError('embedding aborted')
          if (!anyOk) throw batchError // every item failed — keep the original failure semantics
          if (inferredDimension > 0) {
            for (let k = 0; k < salvaged.length; k++) {
              if (salvaged[k] === null) salvaged[k] = new Float32Array(inferredDimension)
            }
          }
          rows.push(...(salvaged as Float32Array[]))
          continue
        }
        throw batchError
      }

      if (jsonReadFailed) {
        throw new EmbeddingError(`${API_VERSION_ERROR_PREFIX}: invalid JSON body: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`)
      }
      const batchRows = extractEmbeddings(json, batch.length)
      inferredDimension = this.acceptRows(batchRows, inferredDimension)
      rows.push(...batchRows)
    }
    const normalized = normalizeRows(rows)
    if (this.dynamic === 0) this.dynamic = inferredDimension
    return normalized
  }
}

function extractEmbeddings(json: unknown, expected: number): Float32Array[] {
  if (typeof json !== 'object' || json === null) {
    throw new EmbeddingError(`${API_VERSION_ERROR_PREFIX}: response root must be an object`)
  }
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data) || (expected > 0 && data.length < expected)) {
    throw new EmbeddingError(`${API_VERSION_ERROR_PREFIX}: response missing embeddings data`)
  }
  if (expected > 0 && data.length > expected) {
    throw new EmbeddingError(`${API_VERSION_ERROR_PREFIX}: response must contain exactly ${expected} embeddings`)
  }
  const out: Float32Array[] = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null) {
      throw new EmbeddingError(`${API_VERSION_ERROR_PREFIX}: embedding entry must be an object`)
    }
    const raw = (item as { embedding?: unknown }).embedding
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new EmbeddingError(`${API_VERSION_ERROR_PREFIX}: embedding entry has no numeric array`)
    }
    out.push(Float32Array.from(raw as number[]))
  }
  if (out.length === 0) {
    throw new EmbeddingError(`${API_VERSION_ERROR_PREFIX}: response contained no embeddings`)
  }
  return out
}

// ---- Factory -----------------------------------------------------------------

/** Per-operation API key resolution hook (see OpenAICompatOptions.resolveKey). */
export type ResolveKey = (signal?: AbortSignal) => Promise<string>

/** Build the provider selected by a resolved provider config. */
export function createProvider(config: ResolvedProviderConfig, resolveKey?: ResolveKey): EmbeddingProvider {
  switch (config.kind) {
    case 'lexical':
      return new LexicalVectorProvider(config.dimension)
    case 'openai':
      return new OpenAICompatProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        dimension: config.dimension,
        timeoutMs: config.timeoutMs,
        // CJK-safe cap, configurable via provider.maxCharsPerText (default
        // 3000): OpenAI-compatible embedding endpoints commonly limit each
        // input item by tokens, and CJK text runs close to one token per
        // character. A 16000-char CJK chunk therefore exceeds typical
        // per-item token limits (measured against one endpoint: a 6900-char
        // CJK chunk was rejected with HTTP 400 / error code 1210, while
        // 16000 ASCII chars ~= 4000 tokens passed). 3000 chars keeps CJK
        // chunks within the limit at a small cost for ASCII-heavy corpora.
        maxCharsPerText: config.maxCharsPerText,
        batchSize: 32,
        ...(typeof resolveKey === 'function' ? { resolveKey } : {}),
      })
  }
}

/** Convenience overload keeping tokenizer re-exports available for tests. */
export { tokenize, termFrequencies }

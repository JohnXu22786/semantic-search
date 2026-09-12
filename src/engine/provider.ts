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
  resolveKey?: () => Promise<string>
}

const API_VERSION_ERROR_PREFIX = 'embedding request failed'

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

  async embed(texts: string[], ctx?: { signal?: AbortSignal }): Promise<Float32Array[]> {
    if (ctx?.signal?.aborted) throw new EmbeddingError('embedding aborted')
    const baseUrl = this.options.baseUrl.replace(/\/+$/, '')
    const url = `${baseUrl}/embeddings`
    // Resolve the key per operation when a resolver is provided (allows
    // rotation without restart); otherwise fall back to the static key.
    const key = (typeof this.options.resolveKey === 'function'
      ? String((await this.options.resolveKey()) ?? '')
      : this.options.apiKey).trim()
    if (key.length === 0) {
      throw new EmbeddingError('openai provider: no API key configured (set provider.apiKey or the env var)')
    }

    const rows: Float32Array[] = []
    const { batchSize, maxCharsPerText, model, timeoutMs } = this.options
    for (let i = 0; i < texts.length; i += batchSize) {
      if (ctx?.signal?.aborted) throw new EmbeddingError('embedding aborted')
      const batch = texts.slice(i, i + batchSize).map((t) => t.slice(0, maxCharsPerText))
      const body = JSON.stringify({ model, input: batch })

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onOuter = (): void => controller.abort()
      ctx?.signal?.addEventListener('abort', onOuter, { once: true })

      let response: Response
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

      if (!response.ok) {
        let detail = ''
        try {
          detail = (await response.text()).slice(0, 400)
        } catch {
          /* best effort */
        }
        const batchError = new EmbeddingError(`${API_VERSION_ERROR_PREFIX}: HTTP ${response.status} ${response.statusText} ${detail}`.trim())
        // A batch-level HTTP 400 (e.g. "parameter error" codes) can be
        // triggered by a single rejected item — commonly one oversized or
        // otherwise invalid chunk. Retry the batch item-by-item so one bad
        // chunk no longer fails the whole embed call and drives the caller
        // into permanent lexical fallback after the first boot build. Good
        // items keep their vectors; bad items get a zero-vector placeholder
        // so row alignment is preserved (search still ranks them through
        // the lexical channel).
        if (response.status === 400 && batch.length > 1) {
          const salvaged: Array<Float32Array | null> = []
          let anyOk = false
          for (const one of batch) {
            try {
              // Per-item retries share the same timeout budget; without a
              // per-item cap, a slow endpoint could hang each retry
              // indefinitely (batch size x unbounded wait).
              const c2 = new AbortController()
              const t2 = setTimeout(() => c2.abort(), timeoutMs)
              const onOuter2 = (): void => c2.abort()
              ctx?.signal?.addEventListener('abort', onOuter2, { once: true })
              let r2: Response
              try {
                r2 = await fetch(url, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                  body: JSON.stringify({ model, input: [one] }),
                  signal: AbortSignal.any([c2.signal, ...(ctx?.signal ? [ctx.signal] : [])]),
                })
              } finally {
                clearTimeout(t2)
                ctx?.signal?.removeEventListener('abort', onOuter2)
              }
              if (!r2.ok) throw new Error('single-item embedding request failed')
              const single = extractEmbeddings(await r2.json(), 1)
              if (this.dynamic === 0 && single[0] !== undefined && single[0].length > 0) {
                // learn the dimension from the first good item so null
                // placeholders can be materialized immediately
                this.dynamic = single[0].length
              }
              salvaged.push(...single)
              anyOk = true
            } catch {
              salvaged.push(null) // placeholder until the dimension is known
            }
          }
          if (!anyOk) throw batchError // every item failed — keep the original failure semantics
          if (this.dynamic > 0) {
            for (let k = 0; k < salvaged.length; k++) {
              if (salvaged[k] === null) salvaged[k] = new Float32Array(this.dynamic)
            }
          }
          rows.push(...(salvaged as Float32Array[]))
          continue
        }
        throw batchError
      }

      let json: unknown
      try {
        json = await response.json()
      } catch (error) {
        throw new EmbeddingError(`${API_VERSION_ERROR_PREFIX}: invalid JSON body: ${error instanceof Error ? error.message : String(error)}`)
      }
      rows.push(...extractEmbeddings(json, batch.length))
    }
    if (this.dynamic === 0 && rows.length > 0) this.dynamic = rows[0]!.length
    return normalizeRows(rows)
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
export type ResolveKey = () => Promise<string>

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
        // CJK-safe cap: OpenAI-compatible embedding endpoints commonly limit
        // each input item by tokens, and CJK text runs close to one token per
        // character. A 16000-char CJK chunk therefore exceeds typical
        // per-item token limits (measured against one endpoint: a 6900-char
        // CJK chunk was rejected with HTTP 400 / error code 1210, while
        // 16000 ASCII chars ~= 4000 tokens passed). 3000 chars keeps CJK
        // chunks within the limit at a small cost for ASCII-heavy corpora.
        maxCharsPerText: 3000,
        batchSize: 32,
        ...(typeof resolveKey === 'function' ? { resolveKey } : {}),
      })
  }
}

/** Convenience overload keeping tokenizer re-exports available for tests. */
export { tokenize, termFrequencies }

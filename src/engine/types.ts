/**
 * Shared data shapes for the semantic-search engine.
 *
 * The engine is deliberately dependency-free: every module either lives here or
 * in `./index.ts` consumers. The dsh-facing wrapper (`src/index.ts`) and the
 * CLI (`src/cli.ts`) both drive the same {@link SearchIndex}.
 */

/** Embedding backends. */
export type ProviderKind = 'lexical' | 'openai'

/** A resolved embedding-provider configuration. */
export type ResolvedProviderConfig =
  | { kind: 'lexical'; dimension: number }
  | { kind: 'openai'; baseUrl: string; apiKey: string; model: string; dimension: number; timeoutMs: number }

/** Context passed into an embed call (optional corpus IDF, cancellation). */
export interface EmbeddingContext {
  /** Term → IDF weights to apply (used by the lexical provider only). */
  idf?: ReadonlyMap<string, number>
  /** Forwarded cancellation signal. */
  signal?: AbortSignal
}

/**
 * Embedding provider contract. A provider turns raw text lines into dense
 * vectors of a fixed dimension; consumers are expected to L2-normalize before
 * storing / comparing unless the provider guarantees normalized output.
 */
export interface EmbeddingProvider {
  readonly kind: ProviderKind
  /** Stable identifier recorded in the persisted index metadata. */
  readonly id: string
  readonly dimension: number
  /** Whether vectors are produced locally (no network). */
  readonly local: boolean
  /** Embed one or more texts; row `i` corresponds to `texts[i]`. */
  embed(texts: string[], ctx?: EmbeddingContext): Promise<Float32Array[]>
  dispose?(): void | Promise<void>
}

/** Index configuration after defaults have been applied. */
export interface EngineConfig {
  /** Absolute workspace root being indexed. */
  root: string
  /** Directory where the persisted index lives. */
  dataDir: string
  provider: ResolvedProviderConfig
  /** Fall back to the built-in lexical provider when the configured one fails. */
  allowFallback: boolean
  /** Basename patterns included in the index (e.g. `*.ts`). */
  include: string[]
  /** Directory/file names to skip (e.g. `node_modules`). */
  ignore: string[]
  /** Skip files larger than this many bytes. */
  maxFileBytes: number
  /** Stop adding files once their total content bytes exceed this. */
  maxTotalBytes: number
  /** Max source lines per chunk. */
  maxLinesPerChunk: number
  /** CJK n-gram size used by the tokenizer. */
  nGram: number
  /** Number of hits returned to callers. */
  topK: number
  /** k constant of the reciprocal-rank fusion. */
  rrfK: number
  /** Candidate count taken from each retrieval channel before fusion. */
  vectorK: number
  /** Hard cap on indexed files (index stays consistent; excess is dropped). */
  maxFiles: number
  /** Hard cap on indexed chunks during a full build. */
  maxChunks: number
  /** Persist after every incremental change. */
  autosave: boolean
  /** Automatically (re)build in the background once loaded. */
  autoIndex: boolean
  /** Watch the root and reindex changed files. */
  watch: boolean
  /** Debounce window for filesystem events. */
  watchDebounceMs: number
}

/** One code/text fragment stored in the index. */
export interface ChunkRecord {
  id: number
  fileId: number
  /** Path relative to the index root (forward slashes). */
  rel: string
  language: string
  /** Nearest enclosing symbol header (empty for plain-text chunks). */
  symbol: string
  /** 1-based, inclusive start line. */
  startLine: number
  /** 1-based, inclusive end line. */
  endLine: number
  content: string
  /** One-line relevance summary for the model/exceptions. */
  summary: string
}

/** Per-file bookkeeping for incremental updates. */
export interface FileRecord {
  id: number
  rel: string
  path: string
  size: number
  mtimeMs: number
  language: string
  chunkIds: number[]
}

/** One hit returned by {@link SearchIndex.search}. */
export interface SearchHit {
  chunkId: number
  /** Path relative to the index root. */
  file: string
  /** Absolute path (for tooling that needs it). */
  path: string
  language: string
  symbol: string
  startLine: number
  endLine: number
  snippet: string
  summary: string
  /** Combined (RRF) score; higher is better. */
  score: number
  /** Cosine similarity for the vector channel, or null when unavailable. */
  vectorScore: number | null
  /** BM25 score for the lexical channel, or null when unavailable. */
  lexicalScore: number | null
}

export interface SearchResult {
  query: string
  /** Set when the index fell back to the local lexical provider. */
  degraded: boolean
  providerId: string
  tookMs: number
  count: number
  hits: SearchHit[]
}

export type BuildMode = 'full' | 'incremental'

export interface BuildResult {
  mode: BuildMode
  added: number
  updated: number
  removed: number
  unchanged: number
  files: number
  chunks: number
  truncated: boolean
  errors: string[]
}

export interface SearchStats {
  root: string
  dataDir: string
  providerId: string
  providerKind: ProviderKind
  dimension: number
  files: number
  chunks: number
  terms: number
  /** Approximate on-disk size in bytes of the persisted index. */
  bytes: number
  builtAt: number | null
  truncated: boolean
  degraded: boolean
  errors: string[]
}

export interface PersistMeta {
  version: number
  providerId: string
  providerKind: ProviderKind
  dimension: number
  root: string
  builtAt: number
  truncated: boolean
}

export type LoadStatus = 'loaded' | 'empty' | 'stale'

export interface LoadResult {
  status: LoadStatus
  meta: PersistMeta | null
  reason?: string
}

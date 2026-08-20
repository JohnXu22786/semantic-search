/**
 * Public engine surface: everything callers outside the plugin entry need.
 * The engine is dependency-free, so it also powers the CLI and user tooling.
 */

export { SearchIndex, makeSnippet, type LogLike } from './search.ts'
export { tokenize, tokenTypes, termFrequencies, containsCjk } from './tokenizer.ts'
export { chunkText, pickSummary, type ChunkCandidate } from './chunker.ts'
export { LexicalIndex } from './lexical.ts'
export {
  LexicalVectorProvider,
  OpenAICompatProvider,
  createProvider,
  EmbeddingError,
  cosine,
  normalizeRows,
} from './provider.ts'
export { fuse, topByCosine } from './retrieve.ts'
export { scanWorkspace, globToRegExp } from './scanner.ts'
export {
  languageForPath,
  isKnownSource,
  knownLanguages,
  matchSymbol,
} from './languages.ts'
export type {
  BuildResult,
  BuildMode,
  ChunkRecord,
  EmbeddingContext,
  EmbeddingProvider,
  EngineConfig,
  FileRecord,
  LoadResult,
  PersistMeta,
  ProviderKind,
  ResolvedProviderConfig,
  SearchHit,
  SearchResult,
  SearchStats,
} from './types.ts'

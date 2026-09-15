/**
 * Plugin configuration: schemastery schema (validated by the dsh loader) plus
 * `resolveConfig`, which applies defaults and resolves paths against a base
 * directory (the harness cwd or a CLI-provided root).
 */

import { isAbsolute, join } from 'node:path'
import z from 'schemastery'
import type { EngineConfig, ResolvedProviderConfig } from './engine/types.ts'
import { allExtensions } from './engine/languages.ts'

export const DEFAULT_INCLUDE = [
  ...allExtensions().map((ext) => `*.${ext}`),
  '*.yaml', '*.yml', '*.json', '*.jsonc', '*.toml', '*.ini', '*.conf', '*.cfg',
  '*.md', '*.markdown', '*.rst', '*.txt',
  '*.html', '*.htm', '*.xml', '*.css', '*.scss', '*.less', '*.sql',
]
export const DEFAULT_IGNORE = [
  'node_modules', '.git', '.hg', '.svn', '.sema',
  'dist', 'build', 'out', 'coverage', 'target', '.gradle', 'obj', 'bin',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', 'tmp', 'temp',
  '.DS_Store',
]
export const DEFAULT_EMBEDDING_API_KEY_ENV = 'SEMA_EMBEDDING_API_KEY'

export interface ProviderConfig {
  kind: 'lexical' | 'openai'
  /** 0 = auto-infer from the endpoint (openai only). lexical defaults to 4096. */
  dimension: number
  baseUrl: string
  apiKey: string
  apiKeyEnv: string
  model: string
  timeoutMs: number
  /** Per-text character cap passed to the embedding provider (openai only). Defaults to a CJK-safe 3000. */
  maxCharsPerText: number
}

export interface PluginConfig {
  root?: string
  dataDir?: string
  provider?: Partial<ProviderConfig>
  allowFallback?: boolean
  include?: string[]
  ignore?: string[]
  maxFileBytes?: number
  maxTotalBytes?: number
  maxLinesPerChunk?: number
  nGram?: number
  topK?: number
  rrfK?: number
  vectorK?: number
  maxFiles?: number
  maxChunks?: number
  autosave?: boolean
  autoIndex?: boolean
  watch?: boolean
  watchDebounceMs?: number
}

export const Config = z.object({
  root: z.string().default(''),
  dataDir: z.string().default('.sema'),
  provider: z.object({
    kind: z.union([z.const('lexical'), z.const('openai')]).default('lexical'),
    dimension: z.number().default(0),
    baseUrl: z.string().default('https://api.openai.com/v1'),
    apiKey: z.string().default(''),
    apiKeyEnv: z.string().default(DEFAULT_EMBEDDING_API_KEY_ENV),
    model: z.string().default('text-embedding-3-small'),
    timeoutMs: z.number().default(60_000),
    maxCharsPerText: z.number().default(3000),
  }),
  allowFallback: z.boolean().default(true),
  include: z.array(z.string()).default([...DEFAULT_INCLUDE]),
  ignore: z.array(z.string()).default([...DEFAULT_IGNORE]),
  maxFileBytes: z.number().default(1_048_576),
  maxTotalBytes: z.number().default(536_870_912),
  maxLinesPerChunk: z.number().default(80),
  nGram: z.number().default(2),
  topK: z.number().default(20),
  rrfK: z.number().default(60),
  vectorK: z.number().default(300),
  maxFiles: z.number().default(20_000),
  maxChunks: z.number().default(200_000),
  autosave: z.boolean().default(true),
  autoIndex: z.boolean().default(true),
  watch: z.boolean().default(true),
  watchDebounceMs: z.number().default(300),
})

function clamp(value: number, min: number, max: number, label: string): number {
  const clamped = Math.min(max, Math.max(min, Math.floor(value)))
  if (clamped !== Math.floor(value)) {
    throw new Error(`config error: ${label} must be between ${min} and ${max}`)
  }
  return clamped
}

/**
 * Merge plugin/CLI config into a fully-resolved engine config.
 * @param raw    config object (already validated-ish; malformed values throw)
 * @param baseDir directory to resolve relative `root`/`dataDir` against
 */
export function resolveConfig(raw: PluginConfig, baseDir: string): EngineConfig {
  const providerIn = raw.provider ?? {}
  const kind = providerIn.kind ?? 'lexical'
  const dataDirRaw = raw.dataDir ?? '.sema'

  let resolvedProvider: ResolvedProviderConfig
  if (kind === 'lexical') {
    const dimension = providerIn.dimension && providerIn.dimension > 0 ? providerIn.dimension : 4096
    resolvedProvider = { kind: 'lexical', dimension: clamp(dimension, 64, 65_536, 'provider.dimension') }
  } else {
    const envName = providerIn.apiKeyEnv ?? DEFAULT_EMBEDDING_API_KEY_ENV
    const apiKey = (providerIn.apiKey ?? '').trim() || (process.env[envName] ?? '').trim()
    resolvedProvider = {
      kind: 'openai',
      baseUrl: (providerIn.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey,
      model: providerIn.model ?? 'text-embedding-3-small',
      dimension: (providerIn.dimension ?? 0) > 0 ? clamp(providerIn.dimension!, 4, 65_536, 'provider.dimension') : 0,
      timeoutMs: clamp(providerIn.timeoutMs ?? 60_000, 100, 3_600_000, 'provider.timeoutMs'),
      maxCharsPerText: clamp(providerIn.maxCharsPerText ?? 3000, 100, 16000, 'provider.maxCharsPerText'),
    }
  }

  const root = raw.root && raw.root.trim().length > 0 ? (isAbsolute(raw.root) ? raw.root : join(baseDir, raw.root)) : baseDir
  const dataDir = isAbsolute(dataDirRaw) ? dataDirRaw : join(root, dataDirRaw)

  return {
    root,
    dataDir,
    provider: resolvedProvider,
    allowFallback: raw.allowFallback ?? true,
    include: raw.include && raw.include.length > 0 ? raw.include : [...DEFAULT_INCLUDE],
    ignore: [...(raw.ignore && raw.ignore.length > 0 ? raw.ignore : DEFAULT_IGNORE)],
    maxFileBytes: clamp(raw.maxFileBytes ?? 1_048_576, 1024, 1_073_741_824, 'maxFileBytes'),
    maxTotalBytes: clamp(raw.maxTotalBytes ?? 536_870_912, 1024, 1_073_741_824 * 8, 'maxTotalBytes'),
    maxLinesPerChunk: clamp(raw.maxLinesPerChunk ?? 80, 4, 4096, 'maxLinesPerChunk'),
    nGram: clamp(raw.nGram ?? 2, 1, 4, 'nGram'),
    topK: clamp(raw.topK ?? 20, 1, 200, 'topK'),
    rrfK: clamp(raw.rrfK ?? 60, 1, 1000, 'rrfK'),
    vectorK: clamp(raw.vectorK ?? 300, 10, 10_000, 'vectorK'),
    maxFiles: clamp(raw.maxFiles ?? 20_000, 10, 1_000_000, 'maxFiles'),
    maxChunks: clamp(raw.maxChunks ?? 200_000, 10, 5_000_000, 'maxChunks'),
    autosave: raw.autosave ?? true,
    autoIndex: raw.autoIndex ?? true,
    watch: raw.watch ?? true,
    watchDebounceMs: clamp(raw.watchDebounceMs ?? 300, 50, 60_000, 'watchDebounceMs'),
  }
}

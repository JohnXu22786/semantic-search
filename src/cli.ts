/**
 * dsh-semantic-search command-line interface.
 *
 * Zero-dependency runner on top of the engine:
 *   sema index                build the full index
 *   sema reindex [--full]     incremental refresh (or full rebuild)
 *   sema search <query...>    hybrid search, prints top hits
 *   sema stats [--json]       index health
 *
 * Global flags: --root --data-dir --provider --dim --base-url --model --api-key.
 * Text output goes to stdout; log lines go to stderr so `--json` stays clean.
 */

import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { resolveConfig, type PluginConfig } from './config.ts'
import { SearchIndex } from './engine/search.ts'
import type { SearchHit } from './engine/types.ts'

interface CliOptions {
  root?: string
  dataDir?: string
  provider?: 'lexical' | 'openai'
  dimension?: number
  baseUrl?: string
  model?: string
  apiKey?: string
  json: boolean
  full: boolean
  topK?: number
  command: string[]
}

const HELP = `dsh-semantic-search — local semantic code search

USAGE
  sema <command> [options]

COMMANDS
  index                 build the full index from the workspace
  reindex [--full]      incremental refresh, or full rebuild with --full
  search <query...>     hybrid vector+BM25 search, prints top hits
  stats [--json]        index health and sizing numbers
  help                  show this help

OPTIONS
  --root <dir>          workspace root (default: current directory)
  --data-dir <dir>      index storage directory (default: <root>/.sema)
  --provider <kind>     embedding provider: lexical | openai (default: lexical)
  --dim <n>             embedding dimension (lexical default: 4096; openai 0=auto)
  --base-url <url>      OpenAI-compatible embeddings endpoint base URL
  --model <name>        embeddings model name (openai only)
  --api-key <key>       API key (openai only; env: SEMA_EMBEDDING_API_KEY)
  --top <n>             hits to print for search (default: 20)
  --json                machine-readable output where supported
  -h, --help            show this help
`

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { json: false, full: false, command: [] }
  const numeric = new Set(['--dim', '--top'])

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') {
      opts.command = ['help']
      return opts
    }
    if (arg === '--json') { opts.json = true; continue }
    if (arg === '--full') { opts.full = true; continue }
    if (arg === '--version') { opts.command = ['version']; continue }
    const assign = (key: keyof CliOptions): void => {
      const val = argv[i + 1]
      if (val === undefined || val.startsWith('--')) throw new Error(`missing value for ${arg}`)
      if (numeric.has(arg)) {
        const num = Number(val)
        if (!Number.isFinite(num)) throw new Error(`invalid numeric value for ${arg}: ${val}`)
        ;(opts as unknown as Record<string, unknown>)[key] = num
      } else {
        ;(opts as unknown as Record<string, unknown>)[key] = val
      }
      i++
    }
    switch (arg) {
      case '--root': assign('root'); break
      case '--data-dir': assign('dataDir'); break
      case '--provider': assign('provider'); break
      case '--dim': assign('dimension'); break
      case '--base-url': assign('baseUrl'); break
      case '--model': assign('model'); break
      case '--api-key': assign('apiKey'); break
      case '--top': assign('topK'); break
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`)
        opts.command.push(arg)
    }
  }
  return opts
}

function buildConfig(opts: CliOptions): PluginConfig {
  const config: PluginConfig = {}
  if (opts.root) config.root = opts.root
  if (opts.dataDir) config.dataDir = opts.dataDir
  const provider: NonNullable<PluginConfig['provider']> = {}
  if (opts.provider) provider.kind = opts.provider
  if (opts.dimension !== undefined) provider.dimension = opts.dimension
  if (opts.baseUrl) provider.baseUrl = opts.baseUrl
  if (opts.model) provider.model = opts.model
  if (opts.apiKey) provider.apiKey = opts.apiKey
  if (Object.keys(provider).length > 0) config.provider = provider
  return config
}

function stderr(...args: unknown[]): void {
  process.stderr.write(args.map((a) => String(a)).join(' ') + '\n')
}

function formatHit(hit: SearchHit): string {
  const where = hit.symbol ? `in ${hit.file} (${hit.symbol})` : `in ${hit.file}`
  const lines = hit.startLine === hit.endLine ? `${hit.startLine}` : `${hit.startLine}-${hit.endLine}`
  const scores = []
  if (hit.vectorScore !== null) scores.push(`vec ${hit.vectorScore.toFixed(3)}`)
  if (hit.lexicalScore !== null) scores.push(`lex ${hit.lexicalScore.toFixed(3)}`)
  const scoreSuffix = scores.length > 0 ? ` [${scores.join(', ')}]` : ''
  return `${hit.file}:${lines} ${where}\n  score=${hit.score.toFixed(3)}${scoreSuffix}\n  ${hit.summary}`
}

/** Entry point used by bin/sema.mjs. */
export async function runCli(argv: string[]): Promise<number> {
  try {
    const opts = parseArgs(argv)
    const cmd = opts.command[0] ?? 'help'

    if (cmd === 'help') {
      process.stdout.write(HELP)
      return 0
    }
    if (cmd === 'version') {
      // Read the version from package.json so the CLI can never drift from
      // the published package version.
      const require = createRequire(import.meta.url)
      process.stdout.write(`${(require('../package.json') as { version: string }).version}\n`)
      return 0
    }

    const cwd = resolve(process.cwd())
    const index = new SearchIndex(resolveConfig(buildConfig(opts), cwd), {
      info: (m) => stderr(m),
      warn: (m) => stderr(m),
      error: (m) => stderr(m),
      debug: () => undefined,
    })

    if (cmd === 'index') {
      const result = await index.build('full')
      const out = {
        ok: true,
        mode: 'full',
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        unchanged: result.unchanged,
        files: result.files,
        chunks: result.chunks,
        truncated: result.truncated,
      }
      if (opts.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n')
      else {
        process.stdout.write(
          `index built: ${out.files} file(s), ${out.chunks} chunk(s), provider=${index.providerId} (dim ${index.dimension})\n` +
            (out.truncated ? 'warning: index truncated by configured limits\n' : ''),
        )
      }
      return 0
    }

    if (cmd === 'reindex') {
      await index.init()
      const result = opts.full ? await index.build('full') : await index.build('refresh')
      const out = {
        ok: true,
        mode: opts.full ? 'full' : result.mode,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        unchanged: result.unchanged,
        files: result.files,
        chunks: result.chunks,
        truncated: result.truncated,
      }
      if (opts.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n')
      else {
        process.stdout.write(
          `${out.mode === 'full' ? 'index rebuilt' : 'index refreshed'}: +${out.added} ~${out.updated} -${out.removed} =${out.unchanged} (${out.chunks} chunk(s))\n`,
        )
      }
      return 0
    }

    if (cmd === 'stats') {
      await index.init()
      const s = await index.stats()
      const out = {
        ok: true,
        root: s.root,
        provider: s.providerId,
        providerKind: s.providerKind,
        dimension: s.dimension,
        files: s.files,
        chunks: s.chunks,
        terms: s.terms,
        bytes: s.bytes,
        built: s.builtAt !== null,
        truncated: s.truncated,
        degraded: s.degraded,
        errors: s.errors,
      }
      if (opts.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n')
      else {
        process.stdout.write(
          `provider:  ${out.provider} (${out.providerKind}, dim ${out.dimension})\n` +
            `root:      ${out.root}\n` +
            `files:     ${out.files}\n` +
            `chunks:    ${out.chunks}\n` +
            `terms:     ${out.terms}\n` +
            `size:      ~${(out.bytes / 1024).toFixed(1)} KiB\n` +
            `built:     ${out.built ? 'yes' : 'no'}\n` +
            (out.truncated ? 'warning: truncated by limits\n' : '') +
            (out.degraded ? 'warning: degraded (local lexical provider)\n' : '') +
            (out.errors.length > 0 ? `errors:\n  - ${out.errors.join('\n  - ')}\n` : ''),
        )
      }
      return 0
    }

    if (cmd === 'search') {
      const query = opts.command.slice(1).join(' ')
      const topK = opts.topK ?? 20
      if (!query || query.trim().length === 0) {
        stderr('search requires a query: sema search "find the retry loop"')
        return 2
      }
      const result = await index.search(query, { topK })
      if (opts.json) {
        process.stdout.write(JSON.stringify({
          ok: true,
          query: result.query,
          count: result.count,
          degraded: result.degraded,
          provider: result.providerId,
          hits: result.hits.map((h) => ({
            file: h.file,
            path: h.path,
            symbol: h.symbol,
            startLine: h.startLine,
            endLine: h.endLine,
            summary: h.summary,
            snippet: h.snippet,
            score: h.score,
            vectorScore: h.vectorScore,
            lexicalScore: h.lexicalScore,
          })),
        }, null, 2) + '\n')
      } else if (result.count === 0) {
        process.stdout.write(`no hits for ${JSON.stringify(query)}\n`)
      } else {
        process.stdout.write(result.hits.map(formatHit).join('\n\n') + '\n')
      }
      return 0
    }

    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`)
    return 2
  } catch (error) {
    stderr(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

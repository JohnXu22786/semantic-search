/**
 * dsh tool definitions for the semantic-search plugin.
 *
 * One aggregated tool is registered on `ctx.tools`:
 *  - sema(action=search|stats|reindex)  natural-language / code query → top-K
 *    fragments, index health report, or an index rebuild / refresh
 *
 * The three former flat tools (sema_search / sema_reindex / sema_stats) keep
 * their execute and render logic verbatim inside this file; only the tool
 * surface is collapsed into one action-based tool (the same aggregation
 * pattern the harness itself uses for its built-in code-intel tools). This
 * keeps the per-round tool schema payload low: three flat schemas the harness
 * injects every round become one.
 *
 * It follows the dsh tool contract ({ name | description | parameters |
 * output: { schema, render } | execute }) and never throws into the harness —
 * failures are reported as `{ ok: false, error }` canonical values so the
 * model can act on them.
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SearchIndex } from './engine/search.ts'

const text = (string: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: string }]

interface HitView {
  file: string
  path: string
  symbol: string
  startLine: number
  endLine: number
  summary: string
  snippet: string
  score: number
  vectorScore: number | null
  lexicalScore: number | null
}

function describeHit(hit: HitView): string {
  const where = hit.symbol ? `in ${hit.file} (${hit.symbol})` : `in ${hit.file}`
  const lines = hit.startLine === hit.endLine ? `${hit.startLine}` : `${hit.startLine}-${hit.endLine}`
  const scores = []
  if (hit.vectorScore !== null) scores.push(`vec ${hit.vectorScore.toFixed(3)}`)
  if (hit.lexicalScore !== null) scores.push(`lex ${hit.lexicalScore.toFixed(3)}`)
  return `${hit.file}:${lines} ${hit.symbol ? `symbol=${hit.symbol} ` : ''}score=${hit.score.toFixed(3)}${scores.length > 0 ? ` (${scores.join(', ')})` : ''}\n    ${hit.summary}`
}

interface SearchArgs {
  query?: string
  top_k?: number
}

interface SearchValue {
  ok: boolean
  query?: string
  count: number
  degraded: boolean
  provider: string
  hits: HitView[]
  error?: string
}

interface ReindexArgs {
  full?: boolean
  path?: string
}

interface ReindexValue {
  ok: boolean
  mode: string
  added: number
  updated: number
  removed: number
  unchanged: number
  files: number
  chunks: number
  truncated: boolean
  error?: string
}

interface StatsValue {
  ok: boolean
  root: string
  provider: string
  providerKind: string
  dimension: number
  files: number
  chunks: number
  terms: number
  bytes: number
  built: boolean
  truncated: boolean
  degraded: boolean
  errors: string[]
  error?: string
}

type AggregateValue = SearchValue | ReindexValue | StatsValue

interface ExecShape {
  signal: AbortSignal
}

/** JSON-compatible value (matches the dsh tool canonical-value constraint). */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Build the tool set; `index` is the shared engine instance. */
export function createTools(index: SearchIndex): ToolDefinition[] {
  // -- former sema_search execute (unchanged) --
  const execSearch = async (args: SearchArgs, exec: ExecShape): Promise<SearchValue> => {
    if (exec.signal.aborted) return { ok: false, query: args.query, count: 0, degraded: false, provider: '', hits: [], error: 'aborted' }
    try {
      const result = await index.search(args.query ?? '', { topK: args.top_k, signal: exec.signal })
      return {
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
      }
    } catch (error) {
      return {
        ok: false,
        query: args.query,
        count: 0,
        degraded: false,
        provider: index.providerId,
        hits: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // -- former sema_reindex execute (unchanged) --
  const execReindex = async (args: ReindexArgs, exec: ExecShape): Promise<ReindexValue> => {
    if (exec.signal.aborted) return { ok: false, mode: '', added: 0, updated: 0, removed: 0, unchanged: 0, files: 0, chunks: 0, truncated: false, error: 'aborted' }
    try {
      let result
      if (typeof args.path === 'string' && args.path.length > 0) {
        result = await index.reindexFile(args.path)
      } else {
        result = await index.build(args.full ? 'full' : 'refresh')
      }
      return {
        ok: true,
        mode: args.full ? 'full' : result.mode,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        unchanged: result.unchanged,
        files: result.files,
        chunks: result.chunks,
        truncated: result.truncated,
      }
    } catch (error) {
      return {
        ok: false,
        mode: '',
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: 0,
        files: 0,
        chunks: 0,
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // -- former sema_stats execute (unchanged) --
  const execStats = async (exec: ExecShape): Promise<StatsValue> => {
    if (exec.signal.aborted) {
      return { ok: false, root: '', provider: '', providerKind: '', dimension: 0, files: 0, chunks: 0, terms: 0, bytes: 0, built: false, truncated: false, degraded: false, errors: [], error: 'aborted' }
    }
    try {
      const s = await index.stats()
      return {
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
    } catch (error) {
      return { ok: false, root: '', provider: '', providerKind: '', dimension: 0, files: 0, chunks: 0, terms: 0, bytes: 0, built: false, truncated: false, degraded: false, errors: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  // -- former renders (unchanged; dispatched by __act) --
  const renderSearch = (args: SearchArgs, value: SearchValue) => {
    if (value.ok === false) return text(`sema_search failed: ${value.error ?? 'unknown error'}`)
    if (value.count === 0) {
      return text(`sema_search: no hits for ${JSON.stringify(args.query)} (${value.degraded ? 'degraded mode' : value.provider})`)
    }
    const lines = value.hits.map(describeHit).join('\n')
    return text(`sema_search: ${value.count} hit(s) for ${JSON.stringify(args.query)} (${value.degraded ? 'degraded, ' : ''}${value.provider})\n${lines}`)
  }

  const renderReindex = (args: ReindexArgs, value: ReindexValue) => {
    if (value.ok === false) return text(`sema_reindex failed: ${value.error ?? 'unknown error'}`)
    const scope = value.mode === 'full' ? 'full rebuild' : value.mode === 'incremental' ? 'incremental refresh' : 'single-file reindex'
    return text(`sema_reindex (${scope})${args.path ? ` of ${args.path}` : ''}:\n` +
      `  files=${value.files}, chunks=${value.chunks} (+${value.added} ~${value.updated} -${value.removed} =${value.unchanged})` +
      (value.truncated ? '\n  warning: index was truncated by configured limits' : ''))
  }

  const renderStats = (value: StatsValue) => {
    if (value.ok === false) return text(`sema_stats failed: ${value.error ?? 'unknown error'}`)
    return text(`sema_stats:\n` +
      `  root:      ${value.root}\n` +
      `  provider:  ${value.provider} (${value.providerKind}, dim ${value.dimension})\n` +
      `  files:     ${value.files}\n` +
      `  chunks:    ${value.chunks}\n` +
      `  terms:     ${value.terms}\n` +
      `  size:      ~${(value.bytes / 1024).toFixed(1)} KiB\n` +
      `  built:     ${value.built ? 'yes' : 'no (will build lazily on first search)'}\n` +
      (value.truncated ? '  warning: built under size limits (partial index)\n' : '') +
      (value.degraded ? '  warning: running degraded on the local lexical provider\n' : '') +
      (value.errors.length > 0 ? `  errors:\n    - ${value.errors.join('\n    - ')}\n` : ''))
  }

  // -- the aggregated tool (3 → 1) --
  const tool = defineTool({
    name: 'sema',
    description:
      'Three semantic-index tools in one. action=search: semantic search over the workspace code index (vector + BM25 fused) - use before writing or grepping to locate code by meaning. ' +
      'action=stats: index health (provider, files/chunks/terms, size, degraded flag) - run to sanity-check before relying on search. ' +
      'action=reindex: refresh the index (incremental by default; full:true rebuilds everything; path re-indexes one file).',
    parameters: {
      action: { type: 'string', required: true, enum: ['search', 'stats', 'reindex'], description: 'Which sub-operation to run: search | stats | reindex. Unknown values are rejected at execute time.' },
      query: { type: 'string', description: 'search: the query, in natural language or code terms.' },
      top_k: { type: 'integer', description: 'search: maximum number of hits to return (default 20).' },
      full: { type: 'boolean', description: 'reindex: rebuild the entire index instead of an incremental refresh.' },
      path: { type: 'string', description: 'reindex: absolute path of a single file to (re)index.' },
    },
    output: {
      // The canonical value shape differs per action, so the schema root
      // stays open and `__act` records which sub-tool produced the value so
      // render dispatches. (`additionalProperties` must be stated explicitly
      // — the dsh schema compiler rejects an omitted value.)
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          __act: { type: 'string', description: 'internal: which sub-tool rendered this value' },
        },
      },
      render: (args, value) => {
        const v = value as unknown as AggregateValue & { __act?: string }
        // Rejected calls return { ok, error } without __act — surface them as
        // plain text instead of falling through to the search renderer.
        if (!v.__act) return text(`sema: ${'error' in v && v.error ? v.error : 'unknown error'}`)
        if (v.__act === 'reindex') return renderReindex(args as ReindexArgs, v as ReindexValue)
        if (v.__act === 'stats') return renderStats(v as StatsValue)
        return renderSearch(args as SearchArgs, v as SearchValue)
      },
    },
    execute: async (args, exec): Promise<Record<string, JsonValue>> => {
      // Reject unknown actions instead of silently falling back to search —
      // the schema declares an enum, but args may still arrive unvalidated.
      const action = args.action
      if (action !== 'search' && action !== 'stats' && action !== 'reindex') {
        return { ok: false, error: `unknown action ${JSON.stringify(action) ?? 'undefined'}: expected one of 'search' | 'stats' | 'reindex'` }
      }
      const value = action === 'reindex'
        ? await execReindex(args, exec)
        : action === 'stats'
          ? await execStats(exec)
          : await execSearch({ query: args.query ?? '', top_k: args.top_k }, exec)
      // Bridge the hand-typed per-action shapes to the open canonical root
      // (the value is validated at runtime against the output schema).
      return { ...(value as unknown as Record<string, JsonValue>), __act: action }
    },
  })
  return [tool]
}

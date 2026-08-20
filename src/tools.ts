/**
 * dsh tool definitions for the semantic-search plugin.
 *
 * Three tools are registered on `ctx.tools`:
 *  - sema_search   natural-language / code query → top-K fragments
 *  - sema_reindex  trigger a full rebuild or incremental refresh
 *  - sema_stats    index health, provider, and sizing numbers
 *
 * Each follows the dsh tool contract ({ name | description | parameters |
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

/** Build the tool set; `index` is the shared engine instance. */
export function createTools(index: SearchIndex): ToolDefinition[] {
  const searchTool = defineTool({
    name: 'sema_search',
    description:
      'Semantic search over the workspace code index. Accepts a natural-language or code-shaped query ' +
      '("how is the session budget enforced", "leaderboard retry loop", "parse dotenv") and returns the most ' +
      'relevant code fragments with file, symbol, line range, and a combined relevance score (vector + BM25 fused). ' +
      'Use before writing or grepping when you need to locate code by meaning rather than exact text.',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query, in natural language or code terms.' },
      top_k: { type: 'integer', description: 'Maximum number of hits to return (default: 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          query: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          degraded: { type: 'boolean', required: true },
          provider: { type: 'string', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                path: { type: 'string', required: true },
                symbol: { type: 'string', required: true },
                startLine: { type: 'integer', required: true },
                endLine: { type: 'integer', required: true },
                summary: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
                score: { type: 'number', required: true },
                vectorScore: {
                  oneOf: [{ type: 'number' }, { type: 'null' }],
                  required: true,
                },
                lexicalScore: {
                  oneOf: [{ type: 'number' }, { type: 'null' }],
                  required: true,
                },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (args, value) => {
        if (value.ok === false) return text(`sema_search failed: ${value.error ?? 'unknown error'}`)
        if (value.count === 0) {
          return text(`sema_search: no hits for ${JSON.stringify(args.query)} (${value.degraded ? 'degraded mode' : value.provider})`)
        }
        const lines = value.hits.map(describeHit).join('\n')
        return text(
          `sema_search: ${value.count} hit(s) for ${JSON.stringify(args.query)} (${value.degraded ? 'degraded, ' : ''}${value.provider})\n${lines}`,
        )
      },
    },
    execute: async (args, exec) => {
      if (exec.signal.aborted) return { ok: false, query: args.query, count: 0, degraded: false, provider: '', hits: [], error: 'aborted' }
      try {
        const result = await index.search(args.query, { topK: args.top_k, signal: exec.signal })
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
    },
  })

  const reindexTool = defineTool({
    name: 'sema_reindex',
    description:
      'Refresh the semantic-search code index. Without arguments this performs an incremental refresh (only files whose ' +
      'size or mtime changed are re-indexed). Pass `full: true` to rebuild everything from scratch (e.g. after changing ' +
      'the provider/dimension). Pass `path` to re-index a single file.',
    parameters: {
      full: { type: 'boolean', description: 'Rebuild the entire index instead of an incremental refresh.' },
      path: { type: 'string', description: 'Absolute path of a single file to (re)index.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          added: { type: 'integer', required: true },
          updated: { type: 'integer', required: true },
          removed: { type: 'integer', required: true },
          unchanged: { type: 'integer', required: true },
          files: { type: 'integer', required: true },
          chunks: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (args, value) => {
        if (value.ok === false) return text(`sema_reindex failed: ${value.error ?? 'unknown error'}`)
        const scope = value.mode === 'full' ? 'full rebuild' : value.mode === 'incremental' ? 'incremental refresh' : 'single-file reindex'
        return text(
          `sema_reindex (${scope})${args.path ? ` of ${args.path}` : ''}:\n` +
            `  files=${value.files}, chunks=${value.chunks} (+${value.added} ~${value.updated} -${value.removed} =${value.unchanged})` +
            (value.truncated ? '\n  warning: index was truncated by configured limits' : ''),
        )
      },
    },
    execute: async (args, exec) => {
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
    },
  })

  const statsTool = defineTool({
    name: 'sema_stats',
    description:
      'Report health of the semantic-search index: provider and embedding dimension, file/chunk/term counts, ' +
      'approximate on-disk size, build time, truncation, and recent errors. Use it to sanity-check that an index ' +
      'exists before relying on sema_search.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          root: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          providerKind: { type: 'string', required: true },
          dimension: { type: 'integer', required: true },
          files: { type: 'integer', required: true },
          chunks: { type: 'integer', required: true },
          terms: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          built: { type: 'boolean', required: true },
          truncated: { type: 'boolean', required: true },
          degraded: { type: 'boolean', required: true },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.ok === false) return text(`sema_stats failed: ${value.error ?? 'unknown error'}`)
        return text(
          `sema_stats:\n` +
            `  root:      ${value.root}\n` +
            `  provider:  ${value.provider} (${value.providerKind}, dim ${value.dimension})\n` +
            `  files:     ${value.files}\n` +
            `  chunks:    ${value.chunks}\n` +
            `  terms:     ${value.terms}\n` +
            `  size:      ~${(value.bytes / 1024).toFixed(1)} KiB\n` +
            `  built:     ${value.built ? 'yes' : 'no (will build lazily on first search)'}\n` +
            (value.truncated ? '  warning: built under size limits (partial index)\n' : '') +
            (value.degraded ? '  warning: running degraded on the local lexical provider\n' : '') +
            (value.errors.length > 0 ? `  errors:\n    - ${value.errors.join('\n    - ')}\n` : ''),
        )
      },
    },
    execute: async (args, exec) => {
      void args
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
    },
  })

  return [searchTool, reindexTool, statsTool]
}

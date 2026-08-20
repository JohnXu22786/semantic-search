/**
 * dsh-semantic-search — DeepSeek Harness plugin for local semantic code search.
 *
 * Loaded by dsh from source (TypeScript-aware loader). Exposes the standard
 * plugin shape { Config, name, inject, apply }:
 *  - registers three tools on ctx.tools (sema_search / sema_reindex / sema_stats);
 *  - loads a persisted index at startup, then keeps it fresh: a watcher on the
 *    configured root re-indexes changed files incrementally.
 *
 * The engine lives in `./engine` and carries zero runtime dependencies; the
 * only external imports here are the dsh/cordis primitives and schemastery.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type PluginConfig } from './config.ts'
import { SearchIndex } from './engine/search.ts'
import { createTools } from './tools.ts'
import { createDirWatcher } from './watcher.ts'

export { Config }
export type { PluginConfig }

/** Cordis plugin metadata. */
export const name = 'semantic-search'

/** Services this plugin requires. */
export const inject: string[] = ['tools']

/**
 * Mount the plugin. All registrations are context-scoped; the returned cleanup
 * unwinds them (watcher + tool disposers) for a clean HMR cycle.
 */
export function apply(ctx: Context, config: PluginConfig): () => void {
  const resolved = resolveConfig(config ?? {}, process.cwd())
  const logger = ctx.logger(name)
  const index = new SearchIndex(resolved, logger)

  const disposers: Array<() => void> = []
  for (const tool of createTools(index)) {
    disposers.push(ctx.tools.register(tool))
  }
  logger.info(`semantic-search mounted: root=${resolved.root} provider=${resolved.provider.kind} providerId=${index.providerId}`)

  // Background boot: load persisted state (if any), then build/refresh per
  // autoIndex. Errors are logged, never thrown (the plugin stays usable — the
  // lazy first-search path will rebuild if the boot failed).
  let booted = false
  const boot = async (): Promise<void> => {
    if (booted) return
    booted = true
    try {
      const loaded = await index.init()
      if (resolved.autoIndex) {
        const result = await (loaded.status === 'loaded'
          ? index.build('refresh')
          : index.build('full'))
        logger.info(
          `semantic-search index ready: ${result.files} file(s), ${result.chunks} chunk(s)${result.truncated ? ' (truncated by limits)' : ''}`,
        )
      } else {
        logger.debug?.('autoIndex disabled; index will build on first search')
      }
    } catch (error) {
      logger.error(`semantic-search boot failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void boot()

  let watcher: ReturnType<typeof createDirWatcher> | undefined
  if (resolved.watch) {
    watcher = createDirWatcher(resolved.root, () => {
      if (!index.ready) return
      void index.build('refresh').catch((error) => {
        logger.warn(`semantic-search refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, {
      debounceMs: resolved.watchDebounceMs,
      // never let our own index writes feed back into a rebuild
      exclude: [index.config.dataDir.split(/[\\/]/).pop() ?? '.sema'],
    })
  }

  return () => {
    watcher?.close()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // best-effort teardown
      }
    }
  }
}

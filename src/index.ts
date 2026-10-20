/**
 * dsh-semantic-search — DeepSeek Harness plugin for local semantic code search.
 *
 * Loaded by dsh from source (TypeScript-aware loader). Exposes the standard
 * plugin shape { Config, name, inject, apply }:
 *  - registers one aggregated tool on ctx.tools
 *    (sema(action=search|stats|reindex));
 *  - loads a persisted index at startup, then keeps it fresh: a watcher on the
 *    configured root re-indexes changed files incrementally.
 *
 * The engine lives in `./engine` and carries zero runtime dependencies; the
 * only external imports here are the dsh/cordis primitives and schemastery.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config, DEFAULT_EMBEDDING_API_KEY_ENV, resolveConfig, type PluginConfig } from './config.ts'
import { SearchIndex } from './engine/search.ts'
import { createTools } from './tools.ts'
import { createDirWatcher } from './watcher.ts'

export { Config }
export type { PluginConfig }

/** Cordis plugin metadata. */
export const name = 'semantic-search'

/** Services this plugin requires. */
// `credentials` resolves the embedding key per operation when the openai
// provider is configured through a stored credential reference.
export const inject: string[] = ['tools', 'credentials']

function waitForCredentialRetry(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, 1000)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/**
 * Mount the plugin. All registrations are context-scoped; the returned cleanup
 * unwinds them (watcher + tool disposers) for a clean HMR cycle.
 */
export function apply(ctx: Context, config: PluginConfig): () => void {
  const raw = config ?? {}
  const resolved = resolveConfig(raw, process.cwd())
  const logger = ctx.logger(name)
  const lifecycle = new AbortController()

  // `resolveConfig` already prefers provider.apiKey and then the named
  // environment variable. Use the credentials store only when both are empty.
  const credRef = raw.provider?.apiKeyEnv ?? DEFAULT_EMBEDDING_API_KEY_ENV
  // Boot-race guard: apply() starts boot -> build -> embed -> resolveKey
  // while the credentials service may still be loading its store. A
  // transiently empty key would fail the first embed and permanently pin
  // the fallback lexical provider (observed: config correct, provider
  // still degraded). Retry until the credential resolves (30s cap; once
  // the store is ready the first iteration resolves immediately).
  const resolveKey = resolved.provider.kind === 'openai'
    && resolved.provider.apiKey.length === 0
    && credRef.length > 0
    ? async (signal?: AbortSignal): Promise<string> => {
        const operationSignal = signal
          ? AbortSignal.any([signal, lifecycle.signal])
          : lifecycle.signal
        for (let i = 0; i < 30; i++) {
          if (operationSignal.aborted) return ''
          const r = await ctx.credentials.resolve(credentialRef(credRef)).catch(() => undefined)
          if (operationSignal.aborted) return ''
          if (r?.value) return r.value
          if (i < 29 && !await waitForCredentialRetry(operationSignal)) return ''
        }
        return ''
      }
    : undefined
  const index = new SearchIndex(resolved, logger, resolveKey)

  const disposers: Array<() => void> = []
  for (const tool of createTools(index, lifecycle.signal)) {
    disposers.push(ctx.tools.register(tool))
  }
  logger.info(`semantic-search mounted: root=${resolved.root} provider=${resolved.provider.kind} providerId=${index.providerId}`)

  // Background boot: load persisted state (if any), then build/refresh per
  // autoIndex. Errors are logged, never thrown (the plugin stays usable — the
  // lazy first-search path will rebuild if the boot failed).
  let booted = false
  let bootComplete = false
  let refreshPending = false
  let disposed = false
  const refresh = (): void => {
    if (disposed) return
    if (!bootComplete) {
      refreshPending = true
      return
    }
    refreshPending = false
    void index.build('refresh', lifecycle.signal).catch((error) => {
      if (!lifecycle.signal.aborted) {
        logger.warn(`semantic-search refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }
  const boot = async (): Promise<void> => {
    if (booted) return
    booted = true
    try {
      const loaded = await index.init()
      if (resolved.autoIndex) {
        const result = await (loaded.status === 'loaded'
          ? index.build('refresh', lifecycle.signal)
          : index.build('full', lifecycle.signal))
        logger.info(
          `semantic-search index ready: ${result.files} file(s), ${result.chunks} chunk(s)${result.truncated ? ' (truncated by limits)' : ''}`,
        )
      } else {
        logger.debug?.('autoIndex disabled; index will build on first search')
      }
    } catch (error) {
      if (!lifecycle.signal.aborted) {
        logger.error(`semantic-search boot failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      bootComplete = true
      if (!disposed && refreshPending) {
        refreshPending = false
        refresh()
      }
    }
  }
  void boot()

  let watcher: ReturnType<typeof createDirWatcher> | undefined
  if (resolved.watch) {
    const dataDirName = index.config.dataDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '.sema'
    watcher = createDirWatcher(resolved.root, refresh, {
      debounceMs: resolved.watchDebounceMs,
      // never let our own index writes feed back into a rebuild
      exclude: [dataDirName],
    })
  }

  return () => {
    disposed = true
    lifecycle.abort()
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

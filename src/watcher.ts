/**
 * Cross-platform directory watcher over the index root.
 *
 * Uses fs.watch with `recursive: true` where supported (Windows/macOS); on
 * platforms (or errors) where recursion is unavailable it falls back to a
 * low-frequency polling re-scan. Events are debounced and paths under an
 * excluded directory (the index data dir) are dropped so our own persistence
 * writes never trigger a reindex cycle.
 */

import { watch, type FSWatcher } from 'node:fs'

export interface WatchHandle {
  close(): void
}

export interface WatcherOptions {
  debounceMs?: number
  pollingMs?: number
}

export interface DirWatcherOptions extends WatcherOptions {
  /** Directory names (any depth) whose events are ignored. */
  exclude?: string[]
}

export function createDirWatcher(
  root: string,
  onChange: () => void,
  opts: DirWatcherOptions = {},
): WatchHandle {
  const debounceMs = Math.max(0, opts.debounceMs ?? 300)
  const pollingMs = Math.max(250, opts.pollingMs ?? 1500)
  const exclude = opts.exclude ?? []
  let closed = false
  let debounce: NodeJS.Timeout | undefined
  let polling: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined

  const isExcluded = (name: string | null): boolean => {
    if (!name) return false
    const normalized = name.replace(/\\/g, '/')
    if (normalized.startsWith('/')) return true // never emitted by fs.watch
    const segments = normalized.split('/')
    return exclude.some((seg) => segments.includes(seg))
  }

  const fire = (name: string | null): void => {
    if (closed) return
    if (isExcluded(name)) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      if (!closed) onChange()
    }, debounceMs)
  }

  const startPolling = (): void => {
    if (polling) return
    polling = setInterval(() => fire(null), pollingMs)
    // keep the event loop alive only while an index is being watched
    polling.unref?.()
  }

  try {
    watcher = watch(root, { recursive: true }, (event, filename) => {
      void event
      fire(filename?.toString() ?? null)
    })
    watcher.on('error', () => {
      if (watcher) {
        watcher.close()
        watcher = undefined
      }
      startPolling()
    })
  } catch {
    startPolling()
  }

  return {
    close(): void {
      closed = true
      if (debounce) clearTimeout(debounce)
      if (polling) clearInterval(polling)
      if (watcher) {
        watcher.close()
        watcher = undefined
      }
    },
  }
}

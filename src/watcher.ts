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
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

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
  let pollingRun: Promise<void> | undefined
  let pollingSnapshot: Map<string, string> | undefined
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

  const takePollingSnapshot = async (): Promise<Map<string, string>> => {
    const entries = await readdir(root, { recursive: true, withFileTypes: true })
    const snapshot = new Map<string, string>()
    for (const entry of entries) {
      const filePath = join(entry.parentPath, entry.name)
      const name = relative(root, filePath).replace(/\\/g, '/')
      if (entry.isDirectory() || isExcluded(name)) continue
      try {
        const info = await stat(filePath)
        if (!info.isFile()) continue
        snapshot.set(name, `${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
      } catch {
        // Ignore files that disappear while the snapshot is being collected.
      }
    }
    return snapshot
  }

  const snapshotsEqual = (left: Map<string, string>, right: Map<string, string>): boolean => {
    if (left.size !== right.size) return false
    for (const [name, signature] of left) {
      if (right.get(name) !== signature) return false
    }
    return true
  }

  const poll = async (): Promise<void> => {
    if (closed || pollingRun) return
    pollingRun = (async () => {
      try {
        const next = await takePollingSnapshot()
        if (closed) return
        const previous = pollingSnapshot
        pollingSnapshot = next
        if (!previous || !snapshotsEqual(previous, next)) {
          fire(null)
        }
      } catch {
        // A transient scan failure should not create a refresh loop.
      } finally {
        pollingRun = undefined
      }
    })()
    await pollingRun
  }

  const startPolling = (): void => {
    if (polling) return
    polling = setInterval(() => {
      void poll()
    }, pollingMs)
    // keep the event loop alive only while an index is being watched
    polling.unref?.()
    void poll()
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

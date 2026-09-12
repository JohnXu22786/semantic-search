/**
 * Directory watcher tests: excluded directory names are ignored at any depth.
 */

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

type WatchCallback = (event: string, filename: string | Buffer | null) => void
interface FakeWatcher {
  on(): FakeWatcher
  close(): void
}

const callbacks: WatchCallback[] = []
const fakeWatcher: FakeWatcher = {
  on(): typeof fakeWatcher {
    return fakeWatcher
  },
  close(): void {},
}

mock.module('node:fs', {
  namedExports: {
    watch: (...args: unknown[]) => {
      callbacks.push(args[2] as WatchCallback)
      return fakeWatcher
    },
  },
})

const { createDirWatcher } = await import('../src/watcher.ts')

test('watcher: excludes matching directory names at any depth', async () => {
  let changes = 0
  const handle = createDirWatcher('/workspace', () => {
    changes += 1
  }, { debounceMs: 0, exclude: ['.sema'] })

  try {
    const callback = callbacks[0]!
    callback('change', 'src/.sema/index.json')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(changes, 0)

    callback('change', 'src/keep/index.json')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(changes, 1)
  } finally {
    handle.close()
    mock.reset()
  }
})

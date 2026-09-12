/**
 * Directory watcher tests: excluded directory names are ignored at any depth.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type WatchCallback = (event: string, filename: string | Buffer | null) => void
interface FakeWatcher {
  on(): FakeWatcher
  close(): void
}

const callbacks: WatchCallback[] = []
let forcePolling = false
const fakeWatcher: FakeWatcher = {
  on(): typeof fakeWatcher {
    return fakeWatcher
  },
  close(): void {},
}

mock.module('node:fs', {
  namedExports: {
    watch: (...args: unknown[]) => {
      if (forcePolling) throw new Error('recursive watch unavailable')
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

test('watcher: polling detects included changes without reacting to excluded changes', async () => {
  forcePolling = true
  const root = await mkdtemp(join(tmpdir(), 'sema-watcher-'))
  await mkdir(join(root, '.sema'))
  await writeFile(join(root, 'source.ts'), 'initial source')
  await writeFile(join(root, '.sema', 'index.json'), 'initial index')

  let changes = 0
  const handle = createDirWatcher(root, () => {
    changes += 1
  }, { debounceMs: 0, pollingMs: 250, exclude: ['.sema'] })

  try {
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.equal(changes, 0)

    await writeFile(join(root, '.sema', 'index.json'), 'updated index')
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.equal(changes, 0)

    await writeFile(join(root, 'source.ts'), 'updated source')
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.equal(changes, 1)
  } finally {
    handle.close()
    forcePolling = false
    await rm(root, { recursive: true, force: true })
  }
})

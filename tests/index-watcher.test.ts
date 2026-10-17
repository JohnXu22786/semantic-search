import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { mock, test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const watcherOptions: Array<{ exclude?: string[] }> = []

mock.module('../src/watcher.ts', {
  namedExports: {
    createDirWatcher: (...args: unknown[]) => {
      watcherOptions.push(args[2] as { exclude?: string[] })
      return { close(): void {} }
    },
  },
})

const { apply } = await import('../src/index.ts')

test('entry: trims trailing separators before deriving the watcher exclusion name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sema-index-watcher-'))
  const registered: unknown[] = []
  const ctx: any = {
    tools: {
      register: (tool: unknown) => {
        registered.push(tool)
        return () => undefined
      },
    },
    logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }),
  }

  try {
    const dispose = apply(ctx, {
      root,
      dataDir: `${join(root, '.sema')}/`,
      provider: { kind: 'lexical', dimension: 64 },
      autoIndex: false,
      autosave: false,
      watch: true,
    })

    try {
      assert.deepEqual(watcherOptions.at(-1)?.exclude, ['.sema'])
    } finally {
      dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let watcherCallback: (() => void) | undefined
let releaseInit!: () => void
let markInitStarted!: () => void
const initStarted = new Promise<void>((resolve) => {
  markInitStarted = resolve
})
const initGate = new Promise<void>((resolve) => {
  releaseInit = resolve
})
const buildModes: string[] = []

class FakeSearchIndex {
  readonly config: any
  readonly providerId = 'test-provider'
  private isReady = false

  constructor(config: any) {
    this.config = config
  }

  get ready(): boolean {
    return this.isReady
  }

  async init(): Promise<{ status: 'empty'; meta: null }> {
    markInitStarted()
    await initGate
    return { status: 'empty', meta: null }
  }

  build(mode: 'full' | 'refresh'): Promise<Record<string, unknown>> {
    buildModes.push(mode)
    return Promise.resolve({ mode, files: 0, chunks: 0, truncated: false })
  }
}

mock.module('../src/engine/search.ts', {
  namedExports: { SearchIndex: FakeSearchIndex },
})
mock.module('../src/watcher.ts', {
  namedExports: {
    createDirWatcher: (_root: string, onChange: () => void) => {
      watcherCallback = onChange
      return { close(): void {} }
    },
  },
})

const { apply } = await import('../src/index.ts')

test('entry: drains queued reconciliation for an initially empty index', async () => {
  const ctx: any = {
    tools: { register: () => () => undefined },
    logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }),
  }
  const dispose = apply(ctx, { autoIndex: false, autosave: false, watch: true })

  try {
    await initStarted
    const callback = watcherCallback
    assert.ok(callback)
    callback()
    assert.deepEqual(buildModes, [])

    releaseInit()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(buildModes, ['refresh'])

    callback()
    assert.deepEqual(buildModes, ['refresh', 'refresh'])
  } finally {
    releaseInit()
    dispose()
  }
})

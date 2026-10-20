import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const calls = {
  init: 0,
  builds: [] as Array<'full' | 'refresh'>,
}

class FakeSearchIndex {
  constructor(_config: unknown, _log: unknown) {}

  async init(): Promise<{ status: 'loaded'; meta: null }> {
    calls.init++
    return { status: 'loaded', meta: null }
  }

  build(mode: 'full' | 'refresh'): Promise<Record<string, unknown>> {
    calls.builds.push(mode)
    return Promise.resolve({
      mode,
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      files: 0,
      chunks: 0,
      truncated: false,
    })
  }
}

mock.module('../src/engine/search.ts', {
  namedExports: { SearchIndex: FakeSearchIndex },
})

const { runCli } = await import('../src/cli.ts')

test('cli: full reindex skips persisted-index initialization', async () => {
  calls.init = 0
  calls.builds.length = 0

  const code = await runCli(['--root', process.cwd(), '--json', 'reindex', '--full'])

  assert.equal(code, 0)
  assert.equal(calls.init, 0)
  assert.deepEqual(calls.builds, ['full'])
})

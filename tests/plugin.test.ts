/**
 * Plugin-entry tests: the dsh contract ({ Config, name, inject, apply }),
 * tool registration, and the end-to-end tool pipeline against a real index.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../src/tools.ts'
import { SearchIndex } from '../src/engine/search.ts'
import { makeWorkspace, testConfig } from './helpers.ts'

interface ToolLike {
  name: string
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

interface InvokableTool {
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<any>
}

function stubContext(registered: ToolLike[]) {
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
  return {
    tools: {
      register: (def: ToolLike) => {
        registered.push(def)
        return () => undefined
      },
    },
    logger: () => logger,
    on: () => () => undefined,
  }
}

test('entry: exports the dsh plugin contract', async () => {
  const mod = await import('../src/index.ts')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.name, 'semantic-search')
  assert.deepEqual(mod.inject, ['tools'])
  assert.ok(mod.Config, 'expected a schemastery Config schema')
})

test('entry: apply registers the aggregated tool and returns a disposer', async () => {
  const registered: ToolLike[] = []
  const ctx: any = stubContext(registered)
  const mod = await import('../src/index.ts')

  const ws = await makeWorkspace({
    'a.ts': 'export function toolWired() { return 42 }',
  })
  try {
    const dispose = mod.apply(ctx, {
      root: ws.root,
      provider: { kind: 'lexical', dimension: 128 },
      autoIndex: false,
      watch: false,
      autosave: false,
      topK: 5,
    })
    assert.equal(typeof dispose, 'function')
    const names = registered.map((t) => t.name).sort()
    assert.deepEqual(names, ['sema'])
    dispose()
  } finally {
    await ws.cleanup()
  }
})

test('tools: sema(action=search) returns hits and summaries through the real index', async () => {
  const ws = await makeWorkspace({
    'src/lib.ts': 'export function handleLogin() { return true }\nexport function handleLogout() { return false }',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    const tools = createTools(index)
    const search = tools.find((t) => t.name === 'sema') as unknown as InvokableTool
    const result = await search.execute({ action: 'search', query: 'handle login' }, { signal: new AbortController().signal })
    assert.equal(result.ok, true)
    assert.ok(result.count > 0)
    assert.ok(result.hits.length > 0)
    assert.equal(result.hits[0].file, 'src/lib.ts')
    assert.ok(result.hits[0].summary.length > 0)
  } finally {
    await ws.cleanup()
  }
})

test('tools: sema(action=search) reports errors instead of throwing', async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export const x = 1' })
  try {
    // unreachable provider + fallback disabled → the lazy build fails loudly
    const index = new SearchIndex(testConfig(ws.root, {
      provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test', dimension: 4, timeoutMs: 500 },
      allowFallback: false,
    }))
    const tools = createTools(index)
    const search = tools.find((t) => t.name === 'sema') as unknown as InvokableTool
    const result = await search.execute({ action: 'search', query: 'anything' }, { signal: new AbortController().signal })
    assert.equal(result.ok, false)
    assert.ok(typeof result.error === 'string' && result.error.length > 0)
  } finally {
    await ws.cleanup()
  }
})

test('tools: sema(action=stats) reports index numbers', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export const x = 1',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const tools = createTools(index)
    const stats = tools.find((t) => t.name === 'sema') as unknown as InvokableTool
    const result = await stats.execute({ action: 'stats' }, { signal: new AbortController().signal })
    assert.equal(result.ok, true)
    assert.equal(result.files, 1)
    assert.equal(result.built, true)
    assert.equal(result.dimension, 256)
  } finally {
    await ws.cleanup()
  }
})

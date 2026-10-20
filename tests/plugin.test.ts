/**
 * Plugin-entry tests: the dsh contract ({ Config, name, inject, apply }),
 * tool registration, and the end-to-end tool pipeline against a real index.
 */

import http from 'node:http'
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

function observably(reg: ToolLike[], log: { info: string[]; error: string[] }) {
  return {
    ...stubContext(reg),
    logger: () => ({
      info: (m: string) => { log.info.push(m) },
      warn: () => undefined,
      error: (m: string) => { log.error.push(m) },
      debug: () => undefined,
    }),
  }
}

async function startEmbeddingServer() {
  let authorized = ''
  let markRequestSeen!: () => void
  const requestSeen = new Promise<void>((resolve) => { markRequestSeen = resolve })
  const server = http.createServer((req, res) => {
    authorized = String(req.headers.authorization ?? '')
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      markRequestSeen()
      const { input } = JSON.parse(body) as { input: string[] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] })) }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    authorization: () => authorized,
    requestSeen,
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}

async function assertConfiguredKeyWins(apiKey: string | undefined, envValue: string, expected: string): Promise<void> {
  const envName = 'SEMA_TEST_EMBEDDING_KEY'
  const previousEnv = process.env[envName]
  process.env[envName] = envValue
  let server: Awaited<ReturnType<typeof startEmbeddingServer>> | undefined
  let ws: Awaited<ReturnType<typeof makeWorkspace>> | undefined
  let dispose: (() => void) | undefined
  try {
    server = await startEmbeddingServer()
    ws = await makeWorkspace({ 'a.ts': 'export const configuredKey = true' })
    const registered: ToolLike[] = []
    let credentialCalls = 0
    const ctx: any = {
      ...stubContext(registered),
      credentials: {
        resolve: async () => {
          credentialCalls++
          return { value: 'sk-store', source: 'file' }
        },
      },
    }
    const mod = await import('../src/index.ts')
    dispose = mod.apply(ctx, {
      root: ws.root,
      provider: {
        kind: 'openai',
        baseUrl: server.baseUrl,
        ...(apiKey === undefined ? {} : { apiKey }),
        apiKeyEnv: envName,
        dimension: 8,
        timeoutMs: 5000,
      },
      autoIndex: true,
      watch: false,
      autosave: false,
      allowFallback: false,
    })
    await server.requestSeen
    assert.equal(server.authorization(), `Bearer ${expected}`)
    assert.equal(credentialCalls, 0)
  } finally {
    dispose?.()
    await server?.close()
    await ws?.cleanup()
    if (previousEnv === undefined) delete process.env[envName]
    else process.env[envName] = previousEnv
  }
}

test('entry: exports the dsh plugin contract', async () => {
  const mod = await import('../src/index.ts')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.name, 'semantic-search')
  assert.deepEqual(mod.inject, ['tools', 'credentials'])
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

test('entry: explicit provider apiKey takes precedence over env and credentials', { timeout: 5000 }, async () => {
  await assertConfiguredKeyWins('sk-explicit', 'sk-env', 'sk-explicit')
})

test('entry: provider apiKeyEnv value takes precedence over credentials', { timeout: 5000 }, async () => {
  await assertConfiguredKeyWins(undefined, 'sk-env', 'sk-env')
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

test('tools: sema rejects unknown actions instead of falling back to search', async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export const x = 1' })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    const tools = createTools(index)
    const sema = tools.find((t) => t.name === 'sema') as unknown as InvokableTool
    // The enum in the parameter schema is enforced by the dsh tool wrapper
    // before execute runs — a bogus action throws ToolArgsError; it never
    // silently falls back to search.
    await assert.rejects(
      sema.execute({ action: 'frobnicate', query: 'x' }, { signal: new AbortController().signal }),
      /action.*must be one of/,
    )
    // Defensive depth: if a rejected value ever reaches render without __act,
    // it surfaces as plain text instead of falling into the search renderer.
    const withRender = sema as unknown as { output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> } }
    const blocks = withRender.output.render({ action: 'frobnicate' }, { ok: false, error: 'unknown action "frobnicate"' })
    assert.equal(blocks.length, 1)
    assert.ok(blocks[0]?.text.includes('unknown action'))
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

test('tools: reindex forwards cancellation to a pending credential lookup', { timeout: 3000 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export const reindexCancellation = true' })
  const controller = new AbortController()
  let resolverSignal: AbortSignal | undefined
  let markResolverStarted!: () => void
  const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve })
  const index = new SearchIndex(testConfig(ws.root, {
    provider: {
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: '',
      dimension: 4,
      timeoutMs: 2000,
    },
    allowFallback: false,
  }), {}, (signal?: AbortSignal) => {
    resolverSignal = signal
    markResolverStarted()
    return new Promise<string>(() => {})
  })
  const reindex = createTools(index).find((tool) => tool.name === 'sema') as unknown as InvokableTool

  try {
    const pending = reindex.execute({ action: 'reindex', full: true }, { signal: controller.signal })
    await resolverStarted
    const abortTime = Date.now()
    controller.abort()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(resolverSignal?.aborted, true)
    assert.ok(Date.now() - abortTime < 500, 'reindex cancellation should beat the provider timeout')
  } finally {
    controller.abort()
    await ws.cleanup()
  }
})

test('tools: path reindex forwards cancellation to its credential wait', { timeout: 3000 }, async () => {
  const server = await startEmbeddingServer()
  const ws = await makeWorkspace({ 'a.ts': 'export const pathReindexCancellation = true' })
  const controller = new AbortController()
  let resolverCalls = 0
  let resolverSignal: AbortSignal | undefined
  let markResolverStarted!: () => void
  const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve })
  const index = new SearchIndex(testConfig(ws.root, {
    provider: {
      kind: 'openai',
      baseUrl: server.baseUrl,
      apiKey: '',
      dimension: 8,
      timeoutMs: 2000,
    },
    allowFallback: false,
  }), {}, (signal?: AbortSignal) => {
    resolverCalls++
    if (resolverCalls === 1) return Promise.resolve('sk-initial')
    resolverSignal = signal
    markResolverStarted()
    return new Promise<string>(() => {})
  })
  const reindex = createTools(index).find((tool) => tool.name === 'sema') as unknown as InvokableTool

  try {
    await index.build('full')
    const pending = reindex.execute({ action: 'reindex', path: ws.paths[0] }, { signal: controller.signal })
    await resolverStarted
    const abortTime = Date.now()
    controller.abort()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(resolverSignal?.aborted, true)
    assert.ok(Date.now() - abortTime < 500, 'path reindex cancellation should beat the provider timeout')
  } finally {
    controller.abort()
    server.close()
    await ws.cleanup()
  }
})

test('entry: boot retries until the credentials service resolves the key', { timeout: 10_000 }, async () => {
  const server = await startEmbeddingServer()
  const ws = await makeWorkspace({ 'a.ts': 'export const bootRace = 1' })
  const registered: ToolLike[] = []
  const log = { info: [] as string[], error: [] as string[] }
  let misses = 0
  const ctx: any = {
    ...observably(registered, log),
    credentials: {
      // the service is still loading its store: empty twice, then ready
      resolve: async () => {
        if (misses < 2) {
          misses++
          return undefined
        }
        return { value: 'sk-late', source: 'file' }
      },
    },
  }
  const mod = await import('../src/index.ts')
  try {
    const dispose = mod.apply(ctx, {
      root: ws.root,
      provider: {
        kind: 'openai',
        baseUrl: server.baseUrl,
        apiKeyEnv: 'SEMA_TEST_EMBEDDING_KEY',
        dimension: 8,
        timeoutMs: 5000,
      },
      autoIndex: true,
      watch: false,
      autosave: false,
    })
    try {
      // wait (well past the two 1s retry intervals) for the boot build to embed
      let requestTimeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          server.requestSeen,
          new Promise<void>((_, reject) => {
            requestTimeout = setTimeout(
              () => reject(new Error(`credential retry did not reach the endpoint after ${misses} miss(es): ${log.error.join(' | ')}; info=${log.info.join(' | ')}; auth=${server.authorization()}`)),
              8000,
            )
          }),
        ])
      } finally {
        if (requestTimeout) clearTimeout(requestTimeout)
      }
      assert.equal(server.authorization(), 'Bearer sk-late')
      assert.equal(misses, 2)
      assert.ok(log.error.length === 0, `expected no boot errors, got: ${log.error.join(' | ')}`)
    } finally {
      dispose()
    }
  } finally {
    await server.close()
    await ws.cleanup()
  }
})

test('entry: disposing aborts boot credential retries', { timeout: 3000 }, async () => {
  const envName = 'SEMA_TEST_ABORTED_CREDENTIAL_KEY'
  const previousEnv = process.env[envName]
  delete process.env[envName]
  const ws = await makeWorkspace({ 'a.ts': 'export const disposedBoot = true' })
  const registered: ToolLike[] = []
  let credentialCalls = 0
  let markResolverStarted!: () => void
  const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve })
  const ctx: any = {
    ...stubContext(registered),
    credentials: {
      resolve: async () => {
        credentialCalls++
        markResolverStarted()
        return undefined
      },
    },
  }
  const mod = await import('../src/index.ts')
  let dispose: (() => void) | undefined
  try {
    dispose = mod.apply(ctx, {
      root: ws.root,
      provider: {
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyEnv: envName,
        dimension: 8,
        timeoutMs: 2000,
      },
      autoIndex: true,
      watch: false,
      autosave: false,
      allowFallback: false,
    })
    await resolverStarted
    dispose()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(credentialCalls, 1)
  } finally {
    dispose?.()
    await ws.cleanup()
    if (previousEnv === undefined) delete process.env[envName]
    else process.env[envName] = previousEnv
  }
})

test('entry: disposing aborts an in-flight tool credential wait', { timeout: 3000 }, async () => {
  const envName = 'SEMA_TEST_DISPOSED_TOOL_KEY'
  const previousEnv = process.env[envName]
  delete process.env[envName]
  const ws = await makeWorkspace({ 'a.ts': 'export const disposedTool = true' })
  const registered: ToolLike[] = []
  let credentialCalls = 0
  let markResolverStarted!: () => void
  const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve })
  const ctx: any = {
    ...stubContext(registered),
    credentials: {
      resolve: async () => {
        credentialCalls++
        markResolverStarted()
        return undefined
      },
    },
  }
  const mod = await import('../src/index.ts')
  let dispose: (() => void) | undefined
  try {
    dispose = mod.apply(ctx, {
      root: ws.root,
      provider: {
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyEnv: envName,
        dimension: 8,
        timeoutMs: 2000,
      },
      autoIndex: false,
      watch: false,
      autosave: false,
      allowFallback: false,
    })
    const sema = registered.find((tool) => tool.name === 'sema') as unknown as InvokableTool
    const operation = new AbortController()
    const pending = sema.execute({ action: 'search', query: 'disposedTool' }, { signal: operation.signal })
    await resolverStarted
    const abortTime = Date.now()
    dispose()
    const result = await pending
    assert.equal(result.ok, false)
    assert.ok(Date.now() - abortTime < 500, 'disposing should stop an in-flight credential retry')
    assert.equal(credentialCalls, 1)
  } finally {
    dispose?.()
    await ws.cleanup()
    if (previousEnv === undefined) delete process.env[envName]
    else process.env[envName] = previousEnv
  }
})

test('entry: disposing aborts an in-flight tool embedding request', { timeout: 3000 }, async () => {
  const envName = 'SEMA_TEST_DISPOSED_HTTP_KEY'
  const previousEnv = process.env[envName]
  delete process.env[envName]
  const ws = await makeWorkspace({ 'a.ts': 'export const disposedHttp = true' })
  const registered: ToolLike[] = []
  let markRequestStarted!: () => void
  let markResponseClosed!: () => void
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve })
  const responseClosed = new Promise<void>((resolve) => { markResponseClosed = resolve })
  const server = http.createServer((req, res) => {
    req.on('end', markRequestStarted)
    req.resume()
    res.on('close', () => {
      if (!res.writableEnded) markResponseClosed()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  let credentialCalls = 0
  const ctx: any = {
    ...stubContext(registered),
    credentials: {
      resolve: async () => {
        credentialCalls++
        return { value: 'sk-tool', source: 'file' }
      },
    },
  }
  const mod = await import('../src/index.ts')
  let dispose: (() => void) | undefined
  try {
    dispose = mod.apply(ctx, {
      root: ws.root,
      provider: {
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKeyEnv: envName,
        dimension: 8,
        timeoutMs: 2000,
      },
      autoIndex: false,
      watch: false,
      autosave: false,
      allowFallback: false,
    })
    const sema = registered.find((tool) => tool.name === 'sema') as unknown as InvokableTool
    const pending = sema.execute({ action: 'search', query: 'disposedHttp' }, { signal: new AbortController().signal })
    await requestStarted
    const abortTime = Date.now()
    dispose()
    const result = await pending
    assert.equal(result.ok, false)
    assert.ok(Date.now() - abortTime < 500, 'disposing should abort the pending embedding request')
    await responseClosed
    assert.equal(credentialCalls, 1)
  } finally {
    dispose?.()
    server.close()
    server.closeAllConnections()
    await ws.cleanup()
    if (previousEnv === undefined) delete process.env[envName]
    else process.env[envName] = previousEnv
  }
})

test('entry: provider timeout aborts boot credential retries', { timeout: 2500 }, async () => {
  const envName = 'SEMA_TEST_TIMED_OUT_CREDENTIAL_KEY'
  const previousEnv = process.env[envName]
  delete process.env[envName]
  const ws = await makeWorkspace({ 'a.ts': 'export const timedOutBoot = true' })
  const registered: ToolLike[] = []
  let credentialCalls = 0
  let markResolverStarted!: () => void
  const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve })
  const ctx: any = {
    ...stubContext(registered),
    credentials: {
      resolve: async () => {
        credentialCalls++
        markResolverStarted()
        return undefined
      },
    },
  }
  const mod = await import('../src/index.ts')
  let dispose: (() => void) | undefined
  try {
    dispose = mod.apply(ctx, {
      root: ws.root,
      provider: {
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyEnv: envName,
        dimension: 8,
        timeoutMs: 100,
      },
      autoIndex: true,
      watch: false,
      autosave: false,
      allowFallback: false,
    })
    await resolverStarted
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(credentialCalls, 1)
  } finally {
    dispose?.()
    await ws.cleanup()
    if (previousEnv === undefined) delete process.env[envName]
    else process.env[envName] = previousEnv
  }
})

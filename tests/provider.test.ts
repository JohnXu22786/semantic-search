/**
 * Embedding provider unit tests: lexical determinism + normalization, and
 * openai-compatible error handling (no live network used).
 */

import http from 'node:http'
import { writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EmbeddingError,
  LexicalVectorProvider,
  OpenAICompatProvider,
  cosine,
  normalizeRows,
} from '../src/engine/provider.ts'
import { SearchIndex } from '../src/engine/search.ts'
import { resolveConfig } from '../src/config.ts'
import { makeWorkspace, testConfig } from './helpers.ts'

function pausePersistence(index: SearchIndex): { started: Promise<void>; release: () => void; restore: () => void } {
  const originalPersist = index.persist.bind(index)
  let markStarted!: () => void
  let releaseGate!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  index.persist = async () => {
    markStarted()
    await gate
  }
  return {
    started,
    release: () => releaseGate(),
    restore: () => { index.persist = originalPersist },
  }
}

async function assertCancellationDuringPersistClearsState(
  index: SearchIndex,
  operation: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const persistence = pausePersistence(index)
  const controller = new AbortController()
  try {
    const pending = operation(controller.signal)
    const rejected = assert.rejects(pending, /aborted/)
    await persistence.started
    const abortTime = Date.now()
    controller.abort()
    await rejected
    assert.ok(Date.now() - abortTime < 500, 'caller cancellation should return promptly during persistence')
    persistence.release()
    await index.init()
    const stats = await index.stats()
    assert.equal(stats.files, 0)
    assert.equal(stats.chunks, 0)
    assert.equal(stats.terms, 0)
    assert.equal(stats.builtAt, null)
  } finally {
    controller.abort()
    persistence.release()
    persistence.restore()
  }
}

test('lexical: vectors are deterministic and normalized', async () => {
  const provider = new LexicalVectorProvider(256)
  const [a, b] = await provider.embed(['retry backoff', 'backoff retry'])
  assert.ok(a)
  assert.ok(b)
  assert.equal(a.length, 256)
  assert.deepEqual(Array.from(a), Array.from((await provider.embed(['retry backoff']))[0]!))
  // L2 norm is 1
  const norm = Math.hypot(...Array.from(a!))
  assert.ok(Math.abs(norm - 1) < 1e-5)
})

test('lexical: cosine is higher for similar sentences', async () => {
  const provider = new LexicalVectorProvider(256)
  const [a, b, c] = await provider.embed(['connect to database', 'connect to database', 'handle user input'])
  assert.ok(cosine(a!, b!) > cosine(a!, c!))
})

test('lexical: respects idf weighting when provided', async () => {
  const provider = new LexicalVectorProvider(64)
  const idf = new Map<string, number>([['rare', 3], ['common', 0.2]])
  const withIdf = await provider.embed(['rare uncommon'], { idf })
  const plain = await provider.embed(['rare uncommon'])
  assert.ok(!isSameVec(withIdf[0]!, plain[0]!), 'expected idf to change the vector')
})

test('lexical: constructor rejects bad dimensions', () => {
  assert.throws(() => new LexicalVectorProvider(0), /positive integer/)
  assert.throws(() => new LexicalVectorProvider(-3), /positive integer/)
  assert.throws(() => new LexicalVectorProvider(100.5), /positive integer/)
})

test('openai: missing api key rejects with a clear message', async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: '   ',
    model: 'x',
    dimension: 0,
    timeoutMs: 200,
    maxCharsPerText: 100,
    batchSize: 2,
  })
  await assert.rejects(provider.embed(['hi']), EmbeddingError)
})

test('openai: unreachable endpoint surfaces EmbeddingError', async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 400,
    maxCharsPerText: 100,
    batchSize: 2,
  })
  await assert.rejects(provider.embed(['hi']), EmbeddingError)
})

test('openai: aborted signal rejects with aborted message', async () => {
  const controller = new AbortController()
  controller.abort()
  const provider = new OpenAICompatProvider({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 400,
    maxCharsPerText: 100,
    batchSize: 2,
  })
  await assert.rejects(provider.embed(['hi'], { signal: controller.signal }), /aborted/)
})

test('openai: resolveKey wait is bounded by timeoutMs', { timeout: 1000 }, async () => {
  let resolverSignal: AbortSignal | undefined
  const provider = new OpenAICompatProvider({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: '',
    model: 'x',
    dimension: 0,
    timeoutMs: 40,
    maxCharsPerText: 100,
    batchSize: 2,
    resolveKey: (signal?: AbortSignal) => {
      resolverSignal = signal
      return new Promise<string>(() => {})
    },
  })

  await assert.rejects(provider.embed(['hi']), /aborted/)
  assert.equal(resolverSignal?.aborted, true)
})

test('openai: caller cancellation interrupts a pending resolveKey', { timeout: 1000 }, async () => {
  const controller = new AbortController()
  let resolverSignal: AbortSignal | undefined
  let markResolverStarted!: () => void
  const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve })
  const provider = new OpenAICompatProvider({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: '',
    model: 'x',
    dimension: 0,
    timeoutMs: 2000,
    maxCharsPerText: 100,
    batchSize: 2,
    resolveKey: (signal?: AbortSignal) => {
      resolverSignal = signal
      markResolverStarted()
      return new Promise<string>(() => {})
    },
  })

  const pending = provider.embed(['hi'], { signal: controller.signal })
  await resolverStarted
  controller.abort()
  await assert.rejects(pending, /aborted/)
  assert.equal(resolverSignal?.aborted, true)
})

test('openai: extra rows in a successful batch response are rejected', async () => {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [
        { embedding: [0.1, 0.2, 0.3] },
        { embedding: [0.4, 0.5, 0.6] },
        { embedding: [0.7, 0.8, 0.9] },
      ] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 2000,
    maxCharsPerText: 100,
    batchSize: 4,
  })
  try {
    await assert.rejects(provider.embed(['one', 'two']), /exactly 2 embeddings/)
  } finally {
    server.close()
  }
})

test('openai: batch 400 falls back to per-item salvage with zero-vector placeholders', async () => {
  const seen: number[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => {
      const input = JSON.parse(body).input as string[]
      seen.push(input.length)
      if (input.length > 1 || input[0] === 'bad') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: '1210', message: 'invalid parameter: input tokens exceed the limit' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 2000,
    maxCharsPerText: 100,
    batchSize: 4,
  })
  try {
    const rows = await provider.embed(['good one', 'bad', 'good two'])
    assert.equal(rows.length, 3)
    assert.equal(seen[0], 3) // first attempt is the batch
    assert.ok(seen.slice(1).every((n) => n === 1)) // then per-item retries
    // the rejected item becomes a zero-vector placeholder; good items carry vectors
    assert.deepEqual(Array.from(rows[1]!), [0, 0, 0])
    assert.ok(rows[0]!.some((v) => v !== 0))
    assert.ok(rows[2]!.some((v) => v !== 0))
  } finally {
    server.close()
  }
})

test('openai: salvage retries share the batch timeout deadline', async () => {
  const itemInputs: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => {
      const input = JSON.parse(body).input as string[]
      if (input.length > 1) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'batch rejected' } }))
        return
      }
      const item = input[0]!
      itemInputs.push(item)
      const delayMs = item === 'first' ? 1000 : 1900
      const timer = setTimeout(() => {
        if (res.destroyed) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))
      }, delayMs)
      res.on('close', () => clearTimeout(timer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 2000,
    maxCharsPerText: 100,
    batchSize: 4,
  })
  try {
    const rows = await provider.embed(['first', 'second', 'third'])
    assert.equal(rows.length, 3)
    assert.deepEqual(itemInputs, ['first', 'second'])
    assert.ok(rows[0]!.some((v) => v !== 0))
    assert.deepEqual(Array.from(rows[1]!), [0, 0, 0])
    assert.deepEqual(Array.from(rows[2]!), [0, 0, 0])
  } finally {
    server.close()
  }
})

test('openai: extra vectors in a salvage response keep subsequent rows aligned', async () => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => {
      const input = JSON.parse(body).input as string[]
      if (input.length > 1) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'batch rejected' } }))
        return
      }
      const embeddings = input[0] === 'extra'
        ? [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }]
        : [{ embedding: [0.1, 0.2, 0.3] }]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: embeddings }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 2000,
    maxCharsPerText: 100,
    batchSize: 4,
  })
  try {
    const rows = await provider.embed(['good', 'extra', 'good after'])
    assert.equal(rows.length, 3)
    assert.ok(rows[0]!.some((v) => v !== 0))
    assert.deepEqual(Array.from(rows[1]!), [0, 0, 0])
    assert.ok(rows[2]!.some((v) => v !== 0))
  } finally {
    server.close()
  }
})

test('openai: rejected salvage response cancels its unread body', async () => {
  let errorBodyClosed = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => {
      const input = JSON.parse(body).input as string[]
      if (input.length > 1) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'batch rejected' } }))
        return
      }
      if (input[0] === 'bad-body') {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.write('pending error body')
        const timer = setTimeout(() => res.end('late error body'), 1200)
        res.on('close', () => {
          errorBodyClosed = true
          clearTimeout(timer)
        })
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 2000,
    maxCharsPerText: 100,
    batchSize: 4,
  })
  try {
    const rows = await provider.embed(['bad-body', 'good'])
    assert.equal(rows.length, 2)
    assert.deepEqual(Array.from(rows[0]!), [0, 0, 0])
    assert.ok(rows[1]!.some((v) => v !== 0))
    assert.equal(errorBodyClosed, true)
  } finally {
    server.close()
  }
})

test('openai: cancellation while reading the batch error body aborts promptly', async () => {
  const controller = new AbortController()
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.write('pending error body')
      const finishTimer = setTimeout(() => res.end('late error body'), 1600)
      const abortTimer = setTimeout(() => controller.abort(), 250)
      res.on('close', () => clearTimeout(finishTimer))
      res.on('close', () => clearTimeout(abortTimer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 3000,
    maxCharsPerText: 100,
    batchSize: 4,
  })
  const startedAt = Date.now()
  try {
    await assert.rejects(provider.embed(['one', 'two'], { signal: controller.signal }), /aborted/)
    assert.ok(Date.now() - startedAt < 1000, 'outer cancellation should interrupt the error body read')
  } finally {
    server.close()
  }
})

test('openai: cancellation while reading a successful batch body rejects promptly', async () => {
  const controller = new AbortController()
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"data":')
      const finishTimer = setTimeout(() => res.end(JSON.stringify([
        { embedding: [0.1, 0.2, 0.3] },
        { embedding: [0.4, 0.5, 0.6] },
      ]) + '}'), 1600)
      const abortTimer = setTimeout(() => controller.abort(), 250)
      res.on('close', () => clearTimeout(finishTimer))
      res.on('close', () => clearTimeout(abortTimer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 3000,
    maxCharsPerText: 100,
    batchSize: 4,
  })
  const startedAt = Date.now()
  try {
    await assert.rejects(provider.embed(['one', 'two'], { signal: controller.signal }), /aborted/)
    assert.ok(Date.now() - startedAt < 1000, 'outer cancellation should interrupt successful response JSON reading')
  } finally {
    server.close()
  }
})

test('openai: cancellation after one salvaged item rejects and stops retries', async () => {
  const controller = new AbortController()
  const itemInputs: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => {
      const input = JSON.parse(body).input as string[]
      if (input.length > 1) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'batch rejected' } }))
        return
      }
      const item = input[0]!
      itemInputs.push(item)
      if (item === 'cancel') {
        controller.abort()
        res.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 2000,
    maxCharsPerText: 100,
    batchSize: 4,
  })
  try {
    await assert.rejects(provider.embed(['good', 'cancel', 'must-not-run'], { signal: controller.signal }), /aborted/)
    assert.deepEqual(itemInputs, ['good', 'cancel'])
  } finally {
    server.close()
  }
})

test('openai: all-items 400 keeps the original batch failure', async () => {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: '1210', message: 'invalid parameter' } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'x',
    dimension: 0,
    timeoutMs: 2000,
    maxCharsPerText: 100,
    batchSize: 4,
  })
  try {
    await assert.rejects(provider.embed(['bad', 'also bad']), /HTTP 400/)
  } finally {
    server.close()
  }
})

test('openai: resolveKey supplies the key per operation', async () => {
  let authorized = ''
  const server = http.createServer((req, res) => {
    authorized = String(req.headers.authorization ?? '')
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: [0.4, 0.5] }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  let calls = 0
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: '',
    model: 'x',
    dimension: 0,
    timeoutMs: 2000,
    maxCharsPerText: 100,
    batchSize: 2,
    resolveKey: async () => {
      calls++
      return 'sk-rotated'
    },
  })
  try {
    const rows = await provider.embed(['hello'])
    assert.equal(rows.length, 1)
    assert.equal(calls, 1)
    assert.equal(authorized, 'Bearer sk-rotated')
  } finally {
    server.close()
  }
})

test('search: cancellation reaches resolveKey during lazy build', { timeout: 2500 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function lazySearchCancellation() { return true }' })
  const controller = new AbortController()
  let markResolverStarted!: () => void
  const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve })
  const index = new SearchIndex(testConfig(ws.root, {
    provider: {
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: '',
      model: 'x',
      dimension: 4,
      timeoutMs: 1200,
    },
    allowFallback: false,
  }), {}, () => {
    markResolverStarted()
    return new Promise<string>(() => {})
  })

  try {
    const pending = index.search('lazySearchCancellation', { signal: controller.signal })
    await resolverStarted
    controller.abort()
    await assert.rejects(pending, (error) => error instanceof Error && error.message === 'embedding aborted')
  } finally {
    await ws.cleanup()
  }
})

test('search: full build forwards abort signal to credential resolution', { timeout: 3000 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function fullBuildCancellation() { return true }' })
  const controller = new AbortController()
  let markResolverStarted!: () => void
  const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve })
  let resolverSignal: AbortSignal | undefined
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

  try {
    const pending = index.build('full', controller.signal)
    const rejected = assert.rejects(pending, /aborted/)
    await resolverStarted
    const abortTime = Date.now()
    controller.abort()
    await rejected
    assert.equal(resolverSignal?.aborted, true)
    assert.ok(Date.now() - abortTime < 500, 'build cancellation should interrupt the pending key wait')
  } finally {
    controller.abort()
    await ws.cleanup()
  }
})

test('search: queued build cancellation rejects before the active build finishes', { timeout: 2500 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function queuedBuildCancellation() { return true }' })
  const activeController = new AbortController()
  const queuedController = new AbortController()
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
  }), {}, () => {
    markResolverStarted()
    return new Promise<string>(() => {})
  })

  try {
    const active = index.build('full', activeController.signal)
    const activeRejected = assert.rejects(active, /aborted/)
    await resolverStarted
    const queued = index.build('refresh', queuedController.signal)
    const queuedRejected = assert.rejects(queued, /aborted/)
    let timer: ReturnType<typeof setTimeout> | undefined
    queuedController.abort()
    const rejectedPromptly = await Promise.race([
      queuedRejected.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 500) }),
    ])
    if (timer) clearTimeout(timer)
    activeController.abort()
    await activeRejected
    await queuedRejected
    assert.equal(rejectedPromptly, true, 'a queued build should reject without waiting for the lock holder')
  } finally {
    activeController.abort()
    queuedController.abort()
    await ws.cleanup()
  }
})

test('search: canceled full build clears partial state', { timeout: 3000 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function canceledFullBuild() { return true }' })
  const controller = new AbortController()
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
  }), {}, () => {
    markResolverStarted()
    return new Promise<string>(() => {})
  })

  try {
    const pending = index.build('full', controller.signal)
    const rejected = assert.rejects(pending, /aborted/)
    await resolverStarted
    const partial = await index.stats()
    assert.equal(partial.files, 1)
    assert.ok(partial.chunks > 0)

    controller.abort()
    await rejected
    const cleared = await index.stats()
    assert.equal(cleared.files, 0)
    assert.equal(cleared.chunks, 0)
    assert.equal(cleared.terms, 0)
    assert.equal(cleared.builtAt, null)
  } finally {
    controller.abort()
    await ws.cleanup()
  }
})

test('search: cancellation during full-build persistence clears state', { timeout: 3000 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function fullPersistCancellation() { return true }' })
  const index = new SearchIndex(testConfig(ws.root, { autosave: true }))
  try {
    await assertCancellationDuringPersistClearsState(index, (signal) => index.build('full', signal))
  } finally {
    await ws.cleanup()
  }
})

test('search: cancellation during refresh persistence clears state', { timeout: 3000 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function refreshPersistCancellation() { return true }' })
  const config = testConfig(ws.root)
  const index = new SearchIndex(config)
  try {
    await index.build('full')
    config.autosave = true
    await writeFile(ws.paths[0]!, 'export function refreshPersistCancellation() { return false }', 'utf8')
    await assertCancellationDuringPersistClearsState(index, (signal) => index.build('refresh', signal))
  } finally {
    await ws.cleanup()
  }
})

test('search: canceled refresh does not reload stale persisted state on lazy search', { timeout: 3000 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function persistedPriorState() { return true }' })
  const index = new SearchIndex(testConfig(ws.root, { autosave: true }))
  try {
    await index.build('full')
    await index.init()
    await writeFile(ws.paths[0]!, 'export function freshlyRebuiltSnapshotNeedle() { return false }', 'utf8')
    await assertCancellationDuringPersistClearsState(index, (signal) => index.build('refresh', signal))

    const result = await index.search('freshlyRebuiltSnapshotNeedle')
    assert.ok(
      result.hits.some((hit) => hit.snippet.includes('freshlyRebuiltSnapshotNeedle')),
      'lazy search should rebuild from the current workspace after refresh cancellation',
    )
  } finally {
    await ws.cleanup()
  }
})

test('search: cancellation during path-reindex persistence clears state', { timeout: 3000 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function reindexPersistCancellation() { return true }' })
  const config = testConfig(ws.root)
  const index = new SearchIndex(config)
  try {
    await index.build('full')
    config.autosave = true
    await assertCancellationDuringPersistClearsState(index, (signal) => index.reindexFile(ws.paths[0]!, signal))
  } finally {
    await ws.cleanup()
  }
})

test('search: refresh build forwards abort signal to credential resolution', { timeout: 3000 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function refreshCancellation() { return true }' })
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      const { input } = JSON.parse(body) as { input: string[] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4] })) }))
    })
  })
  let resolverCalls = 0
  let markRefreshResolverStarted!: () => void
  const refreshResolverStarted = new Promise<void>((resolve) => { markRefreshResolverStarted = resolve })
  let resolverSignal: AbortSignal | undefined
  const controller = new AbortController()

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const index = new SearchIndex(testConfig(ws.root, {
      provider: {
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: '',
        dimension: 4,
        timeoutMs: 2000,
      },
      allowFallback: false,
    }), {}, (signal?: AbortSignal) => {
      resolverCalls++
      if (resolverCalls === 1) return Promise.resolve('sk-initial')
      resolverSignal = signal
      markRefreshResolverStarted()
      return new Promise<string>(() => {})
    })
    await index.build('full')
    await writeFile(ws.paths[0]!, 'export function refreshCancellation() { return false }', 'utf8')

    const pending = index.build('refresh', controller.signal)
    const rejected = assert.rejects(pending, /aborted/)
    await refreshResolverStarted
    const abortTime = Date.now()
    controller.abort()
    await rejected
    assert.equal(resolverSignal?.aborted, true)
    assert.ok(Date.now() - abortTime < 500, 'refresh cancellation should interrupt the pending key wait')
  } finally {
    controller.abort()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await ws.cleanup()
  }
})

test('search: cancelled refresh forces a full rebuild on the next build', { timeout: 3000 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function refreshRecovery() { return true }' })
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      const { input } = JSON.parse(body) as { input: string[] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4] })) }))
    })
  })
  let resolverCalls = 0
  let markRefreshResolverStarted!: () => void
  const refreshResolverStarted = new Promise<void>((resolve) => { markRefreshResolverStarted = resolve })
  const controller = new AbortController()

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const index = new SearchIndex(testConfig(ws.root, {
      provider: {
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: '',
        dimension: 4,
        timeoutMs: 2000,
      },
      allowFallback: false,
    }), {}, () => {
      resolverCalls++
      if (resolverCalls === 1) return Promise.resolve('sk-initial')
      if (resolverCalls === 2) {
        markRefreshResolverStarted()
        return new Promise<string>(() => {})
      }
      return Promise.resolve('sk-recovered')
    })
    await index.build('full')
    await writeFile(ws.paths[0]!, 'export function refreshRecovery() { return false }', 'utf8')

    const pending = index.build('refresh', controller.signal)
    const rejected = assert.rejects(pending, /aborted/)
    await refreshResolverStarted
    controller.abort()
    await rejected

    const refreshed = await index.build('refresh')
    assert.equal(refreshed.files, 1)
    assert.equal(requests, 2, 'the retry should rebuild and re-embed after the cancelled refresh')
  } finally {
    controller.abort()
    server.close()
    server.closeAllConnections()
    await ws.cleanup()
  }
})

test('search: refresh timeout invalidates partial state for the next build', { timeout: 3000 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function refreshTimeoutRecovery() { return true }' })
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      const { input } = JSON.parse(body) as { input: string[] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4] })) }))
    })
  })
  let resolverCalls = 0

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const index = new SearchIndex(testConfig(ws.root, {
      provider: {
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: '',
        dimension: 4,
        timeoutMs: 100,
      },
      allowFallback: false,
    }), {}, () => {
      resolverCalls++
      if (resolverCalls === 1) return Promise.resolve('sk-initial')
      if (resolverCalls === 2) return new Promise<string>(() => {})
      return Promise.resolve('sk-recovered')
    })
    await index.build('full')
    await writeFile(ws.paths[0]!, 'export function refreshTimeoutRecovery() { return false }', 'utf8')
    await assert.rejects(index.build('refresh'), /embedding aborted/)

    const refreshed = await index.build('refresh')
    assert.equal(refreshed.files, 1)
    assert.equal(requests, 2, 'the next refresh should rebuild and re-embed after a provider timeout')
  } finally {
    server.close()
    server.closeAllConnections()
    await ws.cleanup()
  }
})

test('search: cancellation reaches query resolveKey', { timeout: 2500 }, async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function queryCancellation() { return true }' })
  const controller = new AbortController()
  let resolveCalls = 0
  let markQueryResolverStarted!: () => void
  const queryResolverStarted = new Promise<void>((resolve) => { markQueryResolverStarted = resolve })
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => {
      const input = JSON.parse(body).input as string[]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: input.map(() => ({ embedding: [0.4, 0.5, 0.6, 0.7] })) }))
    })
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const index = new SearchIndex(testConfig(ws.root, {
      provider: {
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: '',
        model: 'x',
        dimension: 4,
        timeoutMs: 1200,
      },
      allowFallback: false,
    }), {}, () => {
      resolveCalls++
      if (resolveCalls === 1) return Promise.resolve('sk-test')
      markQueryResolverStarted()
      return new Promise<string>(() => {})
    })
    await index.build('full')

    const pending = index.search('query', { signal: controller.signal })
    await queryResolverStarted
    const abortedAt = Date.now()
    controller.abort()
    await assert.rejects(pending, (error) => error instanceof Error && error.message === 'embedding aborted')
    assert.ok(Date.now() - abortedAt < 500, 'caller cancellation should beat the 1200ms resolver timeout')
  } finally {
    server.close()
    await ws.cleanup()
  }
})

test('normalizeRows: leaves zero vectors untouched', () => {
  const rows = normalizeRows([new Float32Array([0, 0])])
  assert.deepEqual(Array.from(rows[0]!), [0, 0])
})

test('resolveConfig: maxCharsPerText is configurable with a CJK-safe default', () => {
  // default keeps the CJK-safe 3000 baseline
  const def = resolveConfig({ provider: { kind: 'openai', apiKey: 'k' } }, '/tmp')
  assert.equal(def.provider.kind, 'openai')
  assert.equal((def.provider as { maxCharsPerText: number }).maxCharsPerText, 3000)
  // explicit override passes through (ASCII-heavy corpora can raise it)
  const raised = resolveConfig({ provider: { kind: 'openai', apiKey: 'k', maxCharsPerText: 8000 } }, '/tmp')
  assert.equal((raised.provider as { maxCharsPerText: number }).maxCharsPerText, 8000)
  // out-of-range values are rejected loudly (same contract as provider.timeoutMs)
  assert.throws(
    () => resolveConfig({ provider: { kind: 'openai', apiKey: 'k', maxCharsPerText: 99999 } }, '/tmp'),
    /maxCharsPerText must be between 100 and 16000/,
  )
})

function isSameVec(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

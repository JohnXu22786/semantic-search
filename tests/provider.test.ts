/**
 * Embedding provider unit tests: lexical determinism + normalization, and
 * openai-compatible error handling (no live network used).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EmbeddingError,
  LexicalVectorProvider,
  OpenAICompatProvider,
  cosine,
  normalizeRows,
} from '../src/engine/provider.ts'
import { resolveConfig } from '../src/config.ts'

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

test('openai: timeout remains active while a successful response body is stalled', async () => {
  const originalFetch = globalThis.fetch
  const stalled = mockStalledResponse(200)
  globalThis.fetch = stalled.fetch
  try {
    const provider = openAIProvider(30)
    await expectAbortedBeforeDeadline(provider.embed(['hi']), 500)
  } finally {
    stalled.release()
    globalThis.fetch = originalFetch
  }
})

test('openai: timeout remains active while an error response body is stalled', async () => {
  const originalFetch = globalThis.fetch
  const stalled = mockStalledResponse(503)
  globalThis.fetch = stalled.fetch
  try {
    const provider = openAIProvider(30)
    await expectAbortedBeforeDeadline(provider.embed(['hi']), 500)
  } finally {
    stalled.release()
    globalThis.fetch = originalFetch
  }
})

test('openai: caller abort remains connected while the response body is stalled', async () => {
  const originalFetch = globalThis.fetch
  const stalled = mockStalledResponse(200)
  globalThis.fetch = stalled.fetch
  const controller = new AbortController()
  try {
    const provider = openAIProvider(1_000)
    const request = provider.embed(['hi'], { signal: controller.signal })
    await stalled.bodyStarted
    controller.abort()
    await expectAbortedBeforeDeadline(request, 500)
  } finally {
    stalled.release()
    globalThis.fetch = originalFetch
  }
})

test('openai: response completion clears the timeout and caller abort listener', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  let requestSignal: AbortSignal | null | undefined
  globalThis.fetch = async (_input, init) => {
    requestSignal = init?.signal
    return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const result = await openAIProvider(30).embed(['hi'], { signal: controller.signal })
    assert.equal(result.length, 1)
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(requestSignal?.aborted, false)
  } finally {
    globalThis.fetch = originalFetch
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

function openAIProvider(timeoutMs: number): OpenAICompatProvider {
  return new OpenAICompatProvider({
    baseUrl: 'http://embedding.test/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    dimension: 8,
    timeoutMs,
    maxCharsPerText: 100,
    batchSize: 2,
  })
}

function mockStalledResponse(status: number): {
  fetch: typeof globalThis.fetch
  bodyStarted: Promise<void>
  release: () => void
} {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let signal: AbortSignal | null | undefined
  let markBodyStarted!: () => void
  const bodyStarted = new Promise<void>((resolve) => {
    markBodyStarted = resolve
  })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    signal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        markBodyStarted()
        signal?.addEventListener('abort', () => {
          controller.error(new DOMException('The operation was aborted', 'AbortError'))
        }, { once: true })
      },
    })
    return new Response(body, { status })
  }
  return {
    fetch,
    bodyStarted,
    release() {
      if (signal?.aborted) return
      try {
        streamController?.close()
      } catch {
        // The abort signal may have already errored the stream.
      }
    },
  }
}

async function expectAbortedBeforeDeadline(request: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    request.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    ),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
  assert.equal(result.kind, 'rejected', 'request should stop before the watchdog deadline')
  if (result.kind === 'rejected') {
    assert.ok(result.error instanceof EmbeddingError)
    assert.match(result.error.message, /aborted/)
  }
}

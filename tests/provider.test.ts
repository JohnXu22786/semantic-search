/**
 * Embedding provider unit tests: lexical determinism + normalization, and
 * openai-compatible error handling (no live network used).
 */

import http from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EmbeddingError,
  LexicalVectorProvider,
  OpenAICompatProvider,
  cosine,
  normalizeRows,
} from '../src/engine/provider.ts'

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

test('normalizeRows: leaves zero vectors untouched', () => {
  const rows = normalizeRows([new Float32Array([0, 0])])
  assert.deepEqual(Array.from(rows[0]!), [0, 0])
})

function isSameVec(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

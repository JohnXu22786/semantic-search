/**
 * Degradation tests: the plugin remains usable when the configured embedding
 * provider is unreachable (falls back to the built-in lexical provider) and
 * fails loudly when fallback is disabled.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SearchIndex } from '../src/engine/search.ts'
import { LexicalVectorProvider } from '../src/engine/provider.ts'
import { makeWorkspace, testConfig } from './helpers.ts'

const BROKEN = {
  kind: 'openai' as const,
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'sk-test',
  model: 'x',
  dimension: 8,
  timeoutMs: 800,
}

test('build: falls back to lexical provider when openai is unreachable', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function degraded() { return true }',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root, {
      provider: { ...BROKEN },
      allowFallback: true,
    }))
    const result = await index.build('full')
    assert.equal(result.files, 1)
    assert.equal(index.providerId, 'lexical')
    const stats = await index.stats()
    assert.equal(stats.degraded, true)
  } finally {
    await ws.cleanup()
  }
})

test('build: search still finds files while degraded', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function degradedSearch() { return 1 }',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root, {
      provider: { ...BROKEN },
      allowFallback: true,
    }))
    await index.build('full')
    const stats = await index.stats()
    assert.equal(stats.degraded, true)
    assert.equal(stats.providerId, 'lexical')
    const result = await index.search('degradedSearch')
    assert.ok(result.count > 0)
    assert.equal(result.degraded, true)
  } finally {
    await ws.cleanup()
  }
})

test('build: fallback document embeddings use the corpus IDF map', async () => {
  const ws = await makeWorkspace({
    'a.txt': 'raretoken common',
    'b.txt': 'common',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root, {
      provider: { ...BROKEN },
      allowFallback: true,
    }))
    await index.build('full')

    const state = index as unknown as {
      chunksById: Map<number, { content: string }>
      lexical: { idfMap: ReadonlyMap<string, number> }
      vectorsById: Map<number, Float32Array>
    }
    const [chunkId, chunk] = [...state.chunksById.entries()][0]!
    const expected = await new LexicalVectorProvider(index.dimension).embed([chunk.content], {
      idf: state.lexical.idfMap,
    })
    assert.deepEqual(Array.from(state.vectorsById.get(chunkId)!), Array.from(expected[0]!))
  } finally {
    await ws.cleanup()
  }
})

test('refresh: fallback re-embeds unchanged vectors with one local provider', async () => {
  const ws = await makeWorkspace({
    'keep.txt': 'shared alpha',
    'changed.txt': 'unrelated initial',
  })
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    calls++
    if (calls > 1) throw new Error('simulated remote outage')
    const request = JSON.parse(String(init?.body)) as { input?: unknown[] }
    const count = Array.isArray(request.input) ? request.input.length : 0
    const embedding = [1, 0, 0, 0, 0, 0, 0, 0]
    return new Response(JSON.stringify({ data: Array.from({ length: count }, () => ({ embedding })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const remoteConfig = testConfig(ws.root, {
      provider: {
        kind: 'openai',
        baseUrl: 'http://embedding.test/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        dimension: 8,
        timeoutMs: 1_000,
      },
      allowFallback: true,
    })
    const index = new SearchIndex(remoteConfig)
    await index.build('full')

    await writeFile(join(ws.root, 'changed.txt'), 'shared beta', 'utf8')
    await index.build('refresh')

    const stats = await index.stats()
    assert.equal(stats.providerKind, 'lexical')
    assert.equal(stats.dimension, 1_024)
    assert.equal(stats.degraded, true)
    const vectors = (index as unknown as { vectorsById: Map<number, Float32Array> }).vectorsById
    assert.deepEqual([...new Set([...vectors.values()].map((vector) => vector.length))], [stats.dimension])

    const expected = new SearchIndex(testConfig(ws.root, { provider: { kind: 'lexical', dimension: 1_024 } }))
    await expected.build('full')
    const actualHit = (await index.search('shared')).hits.find((hit) => hit.file === 'keep.txt')
    const expectedHit = (await expected.search('shared')).hits.find((hit) => hit.file === 'keep.txt')
    assert.ok(actualHit)
    assert.ok(expectedHit)
    assert.notEqual(actualHit.vectorScore, null)
    assert.notEqual(expectedHit.vectorScore, null)
    assert.ok(Math.abs(actualHit.vectorScore! - expectedHit.vectorScore!) < 1e-6)
  } finally {
    globalThis.fetch = originalFetch
    await ws.cleanup()
  }
})

test('build: fails loudly when fallback is disabled', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function strict() {}',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root, {
      provider: { ...BROKEN },
      allowFallback: false,
    }))
    await assert.rejects(index.build('full'), /embedding failed/)
  } finally {
    await ws.cleanup()
  }
})

test('build: lexical provider never degrades (it is the fallback itself)', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export const fine = true',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const stats = await index.stats()
    assert.equal(stats.degraded, false)
  } finally {
    await ws.cleanup()
  }
})

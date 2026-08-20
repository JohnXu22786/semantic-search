/**
 * BM25 inverted-index tests: scoring order, IDF rarity effects, and the
 * incremental put/remove lifecycle.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LexicalIndex } from '../src/engine/lexical.ts'

function tf(terms: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const t of terms) map.set(t, (map.get(t) ?? 0) + 1)
  return map
}

function setup(): LexicalIndex {
  const index = new LexicalIndex()
  index.put(0, tf(['error', 'handler', 'retry']))
  index.put(1, tf(['connect', 'database', 'retry']))
  index.put(2, tf(['retry', 'retry', 'retry', 'loop']))
  index.refreshIdf()
  return index
}

test('top: doc with repeated query terms ranks first', () => {
  const index = setup()
  const results = index.top(['retry'], 5)
  assert.equal(results[0]!.chunk, 2) // three retries beats one
  assert.ok(results.some((r) => r.chunk === 0))
  assert.ok(results.some((r) => r.chunk === 1))
})

test('top: rare terms contribute higher IDF', () => {
  const index = new LexicalIndex()
  index.put(0, tf(['needle', 'zzz']))
  index.put(1, tf(['needle', 'commonone', 'commonone']))
  index.put(2, tf(['zzz']))
  index.put(3, tf(['zzz']))
  index.refreshIdf()
  // 'needle' appears in 2 documents, 'zzz' in 3 → 'needle' is rarer
  const needleIdf = index.idfOrMax('needle')
  const zzzIdf = index.idfOrMax('zzz')
  assert.ok(needleIdf > zzzIdf, `expected needle (${needleIdf}) > zzz (${zzzIdf})`)
})

test('idfOrMax: unknown terms get a high (as-if unseen) fallback', () => {
  const index = new LexicalIndex()
  index.put(0, tf(['a']))
  index.refreshIdf()
  const known = index.idfOrMax('a')
  const unknown = index.idfOrMax('nope')
  assert.ok(unknown >= known)
})

test('remove: chunk disappears from ranking and doc count', () => {
  const index = setup()
  assert.equal(index.nDocs, 3)
  index.remove(2, tf(['retry', 'retry', 'retry', 'loop']))
  index.refreshIdf()
  assert.equal(index.nDocs, 2)
  const results = index.top(['retry'], 5)
  assert.ok(!results.some((r) => r.chunk === 2))
})

test('remove: idempotent for unknown chunks', () => {
  const index = setup()
  index.remove(99, new Map())
  assert.equal(index.nDocs, 3)
})

test('put: duplicate chunk id is rejected (id discipline)', () => {
  const index = new LexicalIndex()
  index.put(0, tf(['a']))
  assert.throws(() => index.put(0, tf(['b'])), /duplicate chunk id/)
})

test('avgLen and terms reflect additions and removals', () => {
  const index = setup()
  assert.equal(index.terms, 6) // error, handler, retry, connect, database, loop
  assert.ok(index.avgLen > 0)
  index.remove(0, tf(['error', 'handler', 'retry']))
  index.refreshIdf()
  assert.equal(index.terms, 4)
})

test('top: empty query yields no results', () => {
  const index = setup()
  assert.deepEqual(index.top([], 5), [])
})

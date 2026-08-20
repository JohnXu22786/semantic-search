/**
 * Retrieval (RRF fusion + vector ranking) tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fuse, topByCosine } from '../src/engine/retrieve.ts'
import { normalizeRows } from '../src/engine/provider.ts'

test('topByCosine: returns ids ordered by similarity', () => {
  const query = Float32Array.from([1, 0, 0])
  const vectors = normalizeRows([
    Float32Array.from([0.5, 0.5, 0]),
    Float32Array.from([1, 0, 0]),
    Float32Array.from([-1, 0, 0]),
  ])
  const top = topByCosine(vectors.map((v, i) => [i, v] as [number, Float32Array]), query, 3)
  assert.equal(top[0]!.id, 1)
  assert.equal(top[2]!.id, 2)
  assert.ok(top[0]!.score > top[1]!.score)
})

test('fuse: a doc found by both channels outranks single-channel docs', () => {
  const vector = [
    { id: 0, score: 0.9 },
    { id: 1, score: 0.8 },
    { id: 2, score: 0.7 },
  ]
  const lexical = [
    { id: 1, score: 12 },
    { id: 3, score: 10 },
  ]
  const fused = fuse(vector, lexical, { rrfK: 60, topK: 10 })
  assert.equal(fused[0]!.id, 1) // present in both → highest RRF
  const byId = new Map(fused.map((f) => [f.id, f]))
  assert.ok(byId.has(0)) // only in vector → still included
  assert.ok(byId.has(3)) // only in lexical → still included
  assert.equal(byId.get(1)!.vectorScore, 0.8)
  assert.equal(byId.get(1)!.lexicalScore, 12)
})

test('fuse: empty channels degrade gracefully', () => {
  assert.deepEqual(fuse([], [], { rrfK: 60, topK: 5 }), [])
  const only = fuse([{ id: 7, score: 1 }], [], { rrfK: 60, topK: 5 })
  assert.deepEqual(only.map((f) => f.id), [7])
})

test('fuse: topK truncates the fused list', () => {
  const vector = [
    { id: 0, score: 1 },
    { id: 1, score: 1 },
    { id: 2, score: 1 },
  ]
  const fused = fuse(vector, [], { rrfK: 60, topK: 2 })
  assert.equal(fused.length, 2)
})

test('fuse: ties break on the lower id', () => {
  const vector = [{ id: 3, score: 1 }]
  const lexical = [{ id: 1, score: 1 }]
  const fused = fuse(vector, lexical, { rrfK: 60, topK: 10 })
  // both are single-channel; rank 1 in their channel → equal RRF; ties → by id
  assert.equal(fused[0]!.id, 1)
})

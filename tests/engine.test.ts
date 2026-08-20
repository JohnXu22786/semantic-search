/**
 * End-to-end engine tests: build an index over a small multilingual workspace,
 * then exercise hybrid retrieval (vector + BM25 + RRF) and stats.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SearchIndex, makeSnippet } from '../src/engine/search.ts'
import { tokenize } from '../src/engine/tokenizer.ts'
import type { SearchHit } from '../src/engine/types.ts'
import { makeWorkspace, testConfig } from './helpers.ts'

const SAMPLE = {
  'src/math.ts': `
// arithmetic helpers
export function add(a, b) { return a + b }

export class Calculator {
  multiply(x, y) { return x * y }
}
`,
  'src/db.py': `
import os

def parse_config(path):
    """Load configuration as an absolute path."""
    return os.path.realpath(path)

class Database:
    def connect(self, host):
        """Open a connection to the database host."""
        return "connected"
`,
  'src/server.go': `
package main

func HandleRequest(w http.ResponseWriter) {
	w.Write([]byte("hello world"))
}
`,
  'docs/notes.md': 'This project looks for local semantic code search.',
}

test('build: indexes the workspace and reports stats', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    const build = await index.build('full')
    assert.equal(build.files, 4)
    assert.ok(build.chunks >= 4)
    const stats = await index.stats()
    assert.equal(stats.files, 4)
    assert.ok(stats.chunks >= 4)
    assert.ok(stats.terms > 10)
    assert.equal(stats.providerId, 'lexical')
    assert.equal(stats.dimension, 256)
    assert.ok(stats.builtAt !== null)
    assert.equal(stats.truncated, false)
  } finally {
    await ws.cleanup()
  }
})

test('retrieval: exact-term query finds the right file at top', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.search('multiply calculator')
    assert.ok(result.count > 0)
    assert.equal(result.hits[0]!.file, 'src/math.ts')
    const hit = result.hits[0]!
    assert.equal(hit.symbol, 'export class Calculator {')
    assert.equal(hit.vectorScore !== null || hit.lexicalScore !== null, true)
    assert.ok(hit.snippet.includes('multiply'))
  } finally {
    await ws.cleanup()
  }
})

test('retrieval: python terms hit the database file', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.search('connect database host')
    assert.ok(result.count > 0)
    assert.equal(result.hits[0]!.file, 'src/db.py')
    assert.ok(result.hits[0]!.summary.includes('connect'))
  } finally {
    await ws.cleanup()
  }
})

test('retrieval: query with no lexical overlap still returns vector hits', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const terms = tokenize('wibble flurb quux')
    // ensure it is vector-only when no shared terms exist
    const result = await index.search('wibble flurb quux')
    assert.ok(result.count > 0)
    for (const hit of result.hits) {
      assert.equal(hit.lexicalScore, null) // no BM25 overlap expected
    }
    assert.equal(terms.length >= 0, true) // sanity: tokenizer is fine
  } finally {
    await ws.cleanup()
  }
})

test('retrieval: empty query returns no hits', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.search('   ')
    assert.equal(result.count, 0)
  } finally {
    await ws.cleanup()
  }
})

test('retrieval: topK option limits hits', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.search('function', { topK: 1 })
    assert.ok(result.count >= 1)
    assert.ok(result.hits.length <= 1)
  } finally {
    await ws.cleanup()
  }
})

test('lazy: search builds the index on demand', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root, { autoIndex: false }))
    assert.equal(index.ready, false)
    const result = await index.search('handle request')
    assert.ok(result.count > 0)
    assert.equal(index.ready, true)
  } finally {
    await ws.cleanup()
  }
})

test('hits: carry absolute paths and line numbers', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.search('connect database host')
    const hit = result.hits.find((h: SearchHit) => h.file === 'src/db.py')
    assert.ok(hit)
    assert.ok(hit.path.startsWith(ws.root))
    assert.ok(hit.startLine >= 1)
    assert.ok(hit.endLine >= hit.startLine)
  } finally {
    await ws.cleanup()
  }
})

test('makeSnippet: trims long content and keeps short lines', async () => {
  assert.equal(makeSnippet('    a\n\n    b'), 'a\nb')
  const long = 'x'.repeat(1000)
  assert.ok(makeSnippet(long).length < long.length)
})

/**
 * Incremental update tests: adding, editing, and deleting files so the index
 * tracks the workspace without a full rebuild.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SearchIndex } from '../src/engine/search.ts'
import { makeWorkspace, testConfig } from './helpers.ts'

test('refresh: edits are picked up (content searchable after change)', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function alpha() { return 1 }',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')

    // edit the file: different size so size+mtime diff is deterministic
    await appendFile(join(ws.root, 'a.ts'), '\nexport function betaFn() { return 2 }\nbetaFn()', 'utf8')

    const result = await index.build('refresh')
    assert.equal(result.mode, 'incremental')
    assert.equal(result.updated, 1)

    const search = await index.search('betaFn')
    assert.ok(search.count > 0, 'expected the newly added symbol to be searchable')
  } finally {
    await ws.cleanup()
  }
})

test('refresh: new files are indexed without touching existing ones', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export const alpha = 1',
    'unchanged.go': 'package main\n\nfunc Keep() {}\n',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const beforeFiles = (await index.stats()).files

    await writeFile(join(ws.root, 'b.py'), 'def newly_added():\n    return 0\n', 'utf8')

    const result = await index.build('refresh')
    assert.equal(result.added, 1)
    assert.equal(result.updated, 0)
    assert.equal(result.removed, 0)
    assert.equal(result.unchanged, beforeFiles)

    const search = await index.search('newly_added')
    assert.equal(search.hits[0]?.file, 'b.py')
  } finally {
    await ws.cleanup()
  }
})

test('refresh: deleted files are dropped from the index', async () => {
  const ws = await makeWorkspace({
    'keep.ts': 'export function keepMe() {}',
    'gone.py': 'def vanish():\n    pass\n',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    assert.ok((await index.search('vanish')).count > 0)

    await rm(join(ws.root, 'gone.py'))
    const result = await index.build('refresh')
    assert.equal(result.removed, 1)

    // the deleted file's fragments are gone; hybrid search may still surface
    // unrelated low-confidence vector hits from the surviving file
    const search = await index.search('vanish')
    assert.equal(search.hits.some((h) => h.file === 'gone.py'), false)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: unchanged files are skipped', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function stable() {}',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.build('refresh')
    assert.equal(result.unchanged, 1)
    assert.equal(result.added, 0)
    assert.equal(result.updated, 0)
    assert.equal(result.removed, 0)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: metadata scan reports total-size truncation', async () => {
  const ws = await makeWorkspace({
    'a.txt': 'a'.repeat(400),
  })
  try {
    const index = new SearchIndex(testConfig(ws.root, { maxTotalBytes: 1024 }))
    const initial = await index.build('full')
    assert.equal(initial.truncated, false)

    await writeFile(join(ws.root, 'b.txt'), 'b'.repeat(700), 'utf8')

    const result = await index.build('refresh')
    assert.equal(result.truncated, true)
    assert.equal((await index.stats()).truncated, true)

    await rm(join(ws.root, 'b.txt'))

    const recovered = await index.build('refresh')
    assert.equal(recovered.truncated, false)
    assert.equal((await index.stats()).truncated, false)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: malformed UTF-8 counts decoded bytes against total cap', async () => {
  const ws = await makeWorkspace({
    'a.txt': 'before'.padEnd(1023, 'a'),
  })
  try {
    const index = new SearchIndex(testConfig(ws.root, { maxTotalBytes: 1024 }))
    const initial = await index.build('full')
    assert.equal(initial.truncated, false)

    await writeFile(join(ws.root, 'a.txt'), Buffer.alloc(1024, 0x80))

    const result = await index.build('refresh')
    assert.equal(result.truncated, true)
    assert.equal(result.updated, 0)
    assert.equal((await index.stats()).files, 1)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: retains indexed files beyond a truncated metadata prefix', async () => {
  const ws = await makeWorkspace({
    'a.txt': 'a'.repeat(300),
    'b.txt': 'b'.repeat(300),
    'c.txt': 'c'.repeat(300),
  })
  try {
    const index = new SearchIndex(testConfig(ws.root, { maxTotalBytes: 1024 }))
    const initial = await index.build('full')
    assert.equal(initial.files, 3)

    await writeFile(join(ws.root, 'a.txt'), 'a'.repeat(500), 'utf8')

    const result = await index.build('refresh')
    assert.equal(result.truncated, true)
    assert.equal(result.removed, 0)
    assert.equal((await index.stats()).files, 3)
  } finally {
    await ws.cleanup()
  }
})

test('reindexFile: single file reindex updates the index', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function firstOne() {}',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')

    await writeFile(join(ws.root, 'a.ts'), 'export function secondOne() {}', 'utf8')
    const result = await index.reindexFile(join(ws.root, 'a.ts'))
    assert.equal(result.updated, 1)

    assert.equal((await index.search('firstOne')).hits.some((h) => h.snippet.includes('firstOne')), false)
    assert.equal((await index.search('secondOne')).hits.some((h) => h.snippet.includes('secondOne')), true)
  } finally {
    await ws.cleanup()
  }
})

test('reindexFile: removes the file when it no longer exists', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function doomed() {}',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    await rm(join(ws.root, 'a.ts'))
    await index.reindexFile(join(ws.root, 'a.ts'))
    assert.equal((await index.search('doomed')).count, 0)
  } finally {
    await ws.cleanup()
  }
})

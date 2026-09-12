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

async function assertVectorScoreMatchesFullRebuild(index: SearchIndex, root: string, rel: string): Promise<void> {
  const incremental = await index.search('shared')
  const rebuiltIndex = new SearchIndex(testConfig(root))
  await rebuiltIndex.build('full')
  const rebuilt = await rebuiltIndex.search('shared')
  const incrementalHit = incremental.hits.find((hit) => hit.file === rel)
  const rebuiltHit = rebuilt.hits.find((hit) => hit.file === rel)

  assert.ok(incrementalHit, `expected incremental search to return ${rel}`)
  assert.ok(rebuiltHit, `expected full rebuild search to return ${rel}`)
  assert.notEqual(incrementalHit.vectorScore, null)
  assert.notEqual(rebuiltHit.vectorScore, null)
  assert.ok(
    Math.abs(incrementalHit.vectorScore! - rebuiltHit.vectorScore!) < 1e-6,
    `expected ${rel} vector score ${incrementalHit.vectorScore} to match full rebuild ${rebuiltHit.vectorScore}`,
  )
}

test('refresh: additions re-embed unchanged vectors after IDF changes', async () => {
  const ws = await makeWorkspace({
    'keep.txt': 'shared alpha',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')

    await writeFile(join(ws.root, 'added.txt'), 'shared beta', 'utf8')
    await index.build('refresh')

    await assertVectorScoreMatchesFullRebuild(index, ws.root, 'keep.txt')
  } finally {
    await ws.cleanup()
  }
})

test('refresh: updates re-embed unchanged vectors after IDF changes', async () => {
  const ws = await makeWorkspace({
    'keep.txt': 'shared alpha',
    'changed.txt': 'unrelated initial',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')

    await writeFile(join(ws.root, 'changed.txt'), 'shared beta', 'utf8')
    await index.build('refresh')

    await assertVectorScoreMatchesFullRebuild(index, ws.root, 'keep.txt')
  } finally {
    await ws.cleanup()
  }
})

test('refresh: deletions re-embed surviving vectors after IDF changes', async () => {
  const ws = await makeWorkspace({
    'keep.txt': 'shared alpha',
    'removed.txt': 'shared beta',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')

    await rm(join(ws.root, 'removed.txt'))
    await index.build('refresh')

    await assertVectorScoreMatchesFullRebuild(index, ws.root, 'keep.txt')
  } finally {
    await ws.cleanup()
  }
})

test('reindexFile: updates re-embed unchanged vectors after IDF changes', async () => {
  const ws = await makeWorkspace({
    'keep.txt': 'shared alpha',
    'changed.txt': 'unrelated initial',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')

    await writeFile(join(ws.root, 'changed.txt'), 'shared beta', 'utf8')
    await index.reindexFile(join(ws.root, 'changed.txt'))

    await assertVectorScoreMatchesFullRebuild(index, ws.root, 'keep.txt')
  } finally {
    await ws.cleanup()
  }
})

test('removeFile: removals re-embed surviving vectors after IDF changes', async () => {
  const ws = await makeWorkspace({
    'keep.txt': 'shared alpha',
    'removed.txt': 'shared beta',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')

    await rm(join(ws.root, 'removed.txt'))
    await index.removeFile(join(ws.root, 'removed.txt'))

    await assertVectorScoreMatchesFullRebuild(index, ws.root, 'keep.txt')
  } finally {
    await ws.cleanup()
  }
})

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

test('reindexFile: failed reads refresh and persist surviving vectors', async () => {
  const ws = await makeWorkspace({
    'keep.txt': 'shared alpha',
    'removed.txt': 'shared beta',
  })
  try {
    const config = testConfig(ws.root, { autosave: true })
    const index = new SearchIndex(config)
    await index.build('full')

    await rm(join(ws.root, 'removed.txt'))
    const result = await index.reindexFile(join(ws.root, 'removed.txt'))
    assert.equal(result.removed, 1)

    await assertVectorScoreMatchesFullRebuild(index, ws.root, 'keep.txt')

    const reader = new SearchIndex(config)
    assert.equal((await reader.init()).status, 'loaded')
    await assertVectorScoreMatchesFullRebuild(reader, ws.root, 'keep.txt')
  } finally {
    await ws.cleanup()
  }
})

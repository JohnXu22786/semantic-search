/**
 * Incremental update tests: adding, editing, and deleting files so the index
 * tracks the workspace without a full rebuild.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
    assert.equal(result.updated, 0)
    assert.equal(result.removed, 0)
    assert.equal((await index.stats()).files, 3)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: unchanged decoded content counts against the total byte cap', async () => {
  const ws = await makeWorkspace({})
  try {
    await writeFile(join(ws.root, 'existing.txt'), Buffer.alloc(1024, 0x80))
    const config = testConfig(ws.root, { maxTotalBytes: 3500, autosave: true })
    const initialIndex = new SearchIndex(config)
    const initial = await initialIndex.build('full')
    assert.equal(initial.truncated, false)

    const index = new SearchIndex(config)
    assert.equal((await index.init()).status, 'loaded')
    await writeFile(join(ws.root, 'new.txt'), 'n'.repeat(600), 'utf8')

    const result = await index.build('refresh')
    assert.equal(result.truncated, true)
    assert.equal(result.added, 0)
    assert.equal((await index.stats()).files, 1)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: scan errors preserve indexed files missing from the partial inventory', async () => {
  const ws = await makeWorkspace({ 'keep.txt': 'keep this indexed content' })
  const movedRoot = `${ws.root}-moved`
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')

    await rename(ws.root, movedRoot)
    try {
      await writeFile(ws.root, 'not a directory')
      const result = await index.build('refresh')
      assert.equal(result.removed, 0)
      assert.equal((await index.stats()).files, 1)
      assert.ok(result.errors.length > 0)
    } finally {
      await rm(ws.root, { force: true })
      await rename(movedRoot, ws.root)
    }
  } finally {
    await ws.cleanup()
  }
})

test('refresh: retains prior indexed content when a replacement becomes binary', async () => {
  const ws = await makeWorkspace({})
  try {
    const filePath = join(ws.root, 'a.ts')
    await writeFile(filePath, Buffer.concat([
      Buffer.from('export function preserveMe() {}\n'),
      Buffer.alloc(1024, 0x80),
    ]))
    await writeFile(join(ws.root, 'deleted.txt'), 'remove this unrelated indexed file', 'utf8')
    const config = testConfig(ws.root, { maxTotalBytes: 3500, autosave: true })
    await new SearchIndex(config).build('full')

    const index = new SearchIndex(config)
    assert.equal((await index.init()).status, 'loaded')

    await writeFile(filePath, Buffer.from([0x00, 0x01, 0x02]))
    await rm(join(ws.root, 'deleted.txt'))
    await writeFile(join(ws.root, 'new.txt'), 'n'.repeat(600), 'utf8')
    const result = await index.build('refresh')

    assert.equal(result.updated, 0)
    assert.equal(result.added, 0)
    assert.equal(result.removed, 1)
    assert.equal(result.truncated, true)
    assert.equal((await index.stats()).files, 1)
    assert.ok((await index.search('preserveMe')).hits.some((hit) => hit.file === 'a.ts'))
  } finally {
    await ws.cleanup()
  }
})

test('refresh: retained binary replacements do not undercount loaded content bytes', async () => {
  const ws = await makeWorkspace({})
  try {
    const filePath = join(ws.root, 'a.txt')
    const originalContent = Buffer.concat([
      Buffer.from('export function preserveMe() {}\n'),
      Buffer.alloc(1024, 0x80),
    ])
    const indexedTime = new Date('2020-01-02T03:04:05.000Z')
    await writeFile(filePath, originalContent)
    await utimes(filePath, indexedTime, indexedTime)

    const largeCap = testConfig(ws.root, { maxTotalBytes: 4000, autosave: true })
    await new SearchIndex(largeCap).build('full')
    const indexedStat = await stat(filePath)

    const smallCap = testConfig(ws.root, { maxTotalBytes: 3500, autosave: true })
    const index = new SearchIndex(smallCap)
    assert.equal((await index.init()).status, 'loaded')

    await writeFile(filePath, Buffer.alloc(originalContent.length))
    await utimes(filePath, indexedTime, indexedTime)
    const replacementStat = await stat(filePath)
    assert.equal(replacementStat.size, indexedStat.size)
    assert.equal(replacementStat.mtimeMs, indexedStat.mtimeMs)
    await writeFile(join(ws.root, 'new.txt'), 'n'.repeat(600), 'utf8')

    const result = await index.build('refresh')
    assert.equal(result.added, 0)
    assert.equal(result.truncated, true)
    assert.equal((await index.stats()).files, 1)
    assert.ok((await index.search('preserveMe')).hits.some((hit) => hit.file === 'a.txt'))
  } finally {
    await ws.cleanup()
  }
})

test('refresh: same-metadata replacements do not undercount loaded content bytes', async () => {
  const ws = await makeWorkspace({})
  try {
    const filePath = join(ws.root, 'a.txt')
    const originalContent = Buffer.concat([
      Buffer.from('export function preserveMe() {}\n'),
      Buffer.alloc(1024, 0x80),
    ])
    const indexedTime = new Date('2020-01-02T03:04:05.000Z')
    await writeFile(filePath, originalContent)
    await utimes(filePath, indexedTime, indexedTime)

    const largeCap = testConfig(ws.root, { maxTotalBytes: 4000, autosave: true })
    await new SearchIndex(largeCap).build('full')
    const indexedStat = await stat(filePath)

    const smallCap = testConfig(ws.root, { maxTotalBytes: 3500, autosave: true })
    const index = new SearchIndex(smallCap)
    assert.equal((await index.init()).status, 'loaded')

    await writeFile(filePath, Buffer.from('r'.repeat(originalContent.length)))
    await utimes(filePath, indexedTime, indexedTime)
    const replacementStat = await stat(filePath)
    assert.equal(replacementStat.size, indexedStat.size)
    assert.equal(replacementStat.mtimeMs, indexedStat.mtimeMs)
    await writeFile(join(ws.root, 'new.txt'), 'n'.repeat(600), 'utf8')

    const result = await index.build('refresh')
    assert.equal(result.added, 0)
    assert.equal(result.truncated, true)
    assert.equal((await index.stats()).files, 1)
    assert.ok((await index.search('preserveMe')).hits.some((hit) => hit.file === 'a.txt'))
  } finally {
    await ws.cleanup()
  }
})

test('refresh: marks an unchanged loaded index truncated when its decoded total exceeds the cap', async () => {
  const ws = await makeWorkspace({})
  try {
    await writeFile(join(ws.root, 'existing.txt'), Buffer.alloc(1024, 0x80))
    const largeCap = testConfig(ws.root, { maxTotalBytes: 3500, autosave: true })
    await new SearchIndex(largeCap).build('full')

    const smallCap = testConfig(ws.root, { maxTotalBytes: 2000, autosave: true })
    const index = new SearchIndex(smallCap)
    assert.equal((await index.init()).status, 'loaded')

    const result = await index.build('refresh')
    assert.equal(result.truncated, true)
    assert.equal((await index.stats()).truncated, true)
    assert.equal((await index.stats()).files, 1)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: retains the truncation status when no files are indexed', async () => {
  const ws = await makeWorkspace({})
  try {
    const index = new SearchIndex(testConfig(ws.root, { maxTotalBytes: 1024 }))
    const initial = await index.build('full')
    assert.equal(initial.files, 0)

    await writeFile(join(ws.root, 'too-large.txt'), 'x'.repeat(1200), 'utf8')
    const result = await index.build('refresh')

    assert.equal(result.truncated, true)
    assert.equal((await index.stats()).truncated, true)
    assert.equal((await index.stats()).files, 0)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: cancellation after fallback metadata stat prevents autosave', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'a'.repeat(600) })
  try {
    const largeCap = testConfig(ws.root, { maxTotalBytes: 2000, autosave: true })
    await new SearchIndex(largeCap).build('full')

    const smallCap = testConfig(ws.root, { maxTotalBytes: 1024, autosave: true })
    const index = new SearchIndex(smallCap)
    assert.equal((await index.init()).status, 'loaded')
    await writeFile(join(ws.root, 'a.txt'), 'b'.repeat(1200), 'utf8')

    const indexPath = join(smallCap.dataDir, 'index.json')
    const before = await readFile(indexPath, 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 10))
    let checks = 0
    const signal = {
      get aborted() {
        checks++
        return checks >= 14
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal

    await assert.rejects(index.build('refresh', signal), /embedding aborted/)
    assert.equal(await readFile(indexPath, 'utf8'), before)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: clears truncation when a replacement brings a loaded index under the cap', async () => {
  const ws = await makeWorkspace({})
  try {
    await writeFile(join(ws.root, 'malformed.txt'), Buffer.alloc(1024, 0x80))
    await writeFile(join(ws.root, 'shrink.txt'), 'x'.repeat(500), 'utf8')
    const largeCap = testConfig(ws.root, { maxTotalBytes: 4000, autosave: true })
    await new SearchIndex(largeCap).build('full')

    const smallCap = testConfig(ws.root, { maxTotalBytes: 3500, autosave: true })
    const index = new SearchIndex(smallCap)
    assert.equal((await index.init()).status, 'loaded')
    await writeFile(join(ws.root, 'shrink.txt'), 'small', 'utf8')

    const result = await index.build('refresh')
    assert.equal(result.updated, 1)
    assert.equal(result.truncated, false)
    assert.equal((await index.stats()).truncated, false)
    assert.equal((await index.stats()).files, 2)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: retains prior indexed content when a file exceeds maxFileBytes', async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export function originalContent() {}' })
  try {
    const index = new SearchIndex(testConfig(ws.root, { maxFileBytes: 1024 }))
    await index.build('full')

    await writeFile(
      join(ws.root, 'a.ts'),
      `export function replacementContent() {}\n${'x'.repeat(1100)}`,
      'utf8',
    )
    const result = await index.build('refresh')

    assert.equal(result.truncated, true)
    assert.equal((await index.stats()).files, 1)
    assert.ok((await index.search('originalContent')).hits.some((hit) => hit.file === 'a.ts'))
  } finally {
    await ws.cleanup()
  }
})

test('refresh: excluded oversized files do not block unrelated deletion reconciliation', async () => {
  const ws = await makeWorkspace({
    'keep.ts': 'export function keepMe() {}',
    'deleted.ts': 'export function removeMe() {}',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root, { maxFileBytes: 1024 }))
    await index.build('full')

    await rm(join(ws.root, 'deleted.ts'))
    await writeFile(join(ws.root, 'huge.bin'), Buffer.alloc(1200))
    const result = await index.build('refresh')

    assert.equal(result.truncated, false)
    assert.equal(result.removed, 1)
    assert.equal((await index.stats()).files, 1)
  } finally {
    await ws.cleanup()
  }
})

test('refresh: binary files do not consume the metadata total-byte cap', async () => {
  const ws = await makeWorkspace({ 'keep.txt': 'existing indexed content' })
  try {
    const index = new SearchIndex(testConfig(ws.root, { maxTotalBytes: 1024 }))
    await index.build('full')

    await writeFile(
      join(ws.root, 'a-binary.txt'),
      Buffer.concat([Buffer.from([0]), Buffer.alloc(1200, 0x61)]),
    )
    await writeFile(join(ws.root, 'new.txt'), 'new searchable content', 'utf8')
    const result = await index.build('refresh')

    assert.equal(result.truncated, false)
    assert.equal(result.added, 1)
    assert.equal((await index.stats()).files, 2)
    assert.ok((await index.search('searchable')).hits.some((hit) => hit.file === 'new.txt'))
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

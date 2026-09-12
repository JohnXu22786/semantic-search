/**
 * Persistence tests: round-trip through the on-disk index, and staleness
 * handling when the provider/dimension no longer matches.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FORMAT_VERSION, INDEX_FILE, VECTORS_FILE } from '../src/engine/persist.ts'
import { SearchIndex } from '../src/engine/search.ts'
import { makeWorkspace, testConfig } from './helpers.ts'

test('persist/load: rebuilt from disk, the index answers queries', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function roundTrip() { return 1 }',
  })
  try {
    const config = testConfig(ws.root, { autosave: true })
    const writer = new SearchIndex(config)
    await writer.build('full')
    assert.ok(existsSync(join(config.dataDir, INDEX_FILE)))
    assert.ok(existsSync(join(config.dataDir, VECTORS_FILE)))

    const reader = new SearchIndex(config)
    const loaded = await reader.init()
    assert.equal(loaded.status, 'loaded')
    assert.equal(reader.ready, true)
    const result = await reader.search('roundTrip')
    assert.ok(result.count > 0)
    assert.equal(result.hits[0]!.file, 'a.ts')
  } finally {
    await ws.cleanup()
  }
})

test('persist/load: empty index after reindexing the last file is loadable', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function becomesEmpty() {}',
  })
  try {
    const config = testConfig(ws.root, { autosave: true })
    const writer = new SearchIndex(config)
    await writer.build('full')

    await writeFile(join(ws.root, 'a.ts'), '', 'utf8')
    await writer.reindexFile(join(ws.root, 'a.ts'))

    const reader = new SearchIndex(config)
    const loaded = await reader.init()
    assert.equal(loaded.status, 'loaded')
    assert.equal(reader.ready, true)
    assert.equal((await reader.stats()).chunks, 0)

    await writeFile(join(ws.root, 'a.ts'), 'export function returnsLater() {}', 'utf8')
    const refreshed = await reader.build('refresh')
    assert.equal(refreshed.updated, 1)
    assert.ok((await reader.search('returnsLater')).count > 0)
  } finally {
    await ws.cleanup()
  }
})

test('persist/load: auto-dimension provider loads an empty index without probing', async () => {
  const ws = await makeWorkspace({})
  try {
    const config = testConfig(ws.root, {
      autosave: true,
      provider: { kind: 'openai', dimension: 0 },
    })
    await new SearchIndex(config).build('full')

    const reader = new SearchIndex(config)
    const loaded = await reader.init()
    assert.equal(loaded.status, 'loaded')
  } finally {
    await ws.cleanup()
  }
})

test('persist/load: dimension change marks the index stale', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export const value = 1',
  })
  try {
    const configA = testConfig(ws.root, { autosave: true })
    await new SearchIndex(configA).build('full')

    const configB = testConfig(ws.root, { provider: { kind: 'lexical', dimension: 512 } })
    const reader = new SearchIndex(configB)
    const loaded = await reader.init()
    assert.equal(loaded.status, 'stale')
    assert.match(loaded.reason ?? '', /dimension/i)

    // a forced full build replaces the stale index
    await reader.build('full')
    assert.equal(reader.ready, true)
    const again = await reader.init()
    assert.equal(again.status, 'loaded')
  } finally {
    await ws.cleanup()
  }
})

test('persist/load: pre-IDF-refresh indexes are invalidated', async () => {
  const ws = await makeWorkspace({
    'a.txt': 'shared alpha',
  })
  try {
    const config = testConfig(ws.root, { autosave: true })
    await new SearchIndex(config).build('full')

    const indexPath = join(config.dataDir, INDEX_FILE)
    const persisted = JSON.parse(await readFile(indexPath, 'utf8')) as { meta: { version: number } }
    persisted.meta.version = FORMAT_VERSION - 1
    await writeFile(indexPath, JSON.stringify(persisted), 'utf8')

    const reader = new SearchIndex(config)
    const loaded = await reader.init()
    assert.equal(loaded.status, 'stale')
    assert.match(loaded.reason ?? '', /format/i)
  } finally {
    await ws.cleanup()
  }
})

test('persist/load: noisy/corrupt data results in stale rather than crash', async () => {
  const ws = await makeWorkspace({})
  try {
    const config = testConfig(ws.root)
    // write a corrupt index.json and a placeholder vectors.bin so the loader
    // parses (and fails on) the index rather than bailing on a missing file
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(config.dataDir, { recursive: true }).catch(() => undefined)
    await writeFile(join(config.dataDir, INDEX_FILE), '{not json', 'utf8')
    await writeFile(join(config.dataDir, VECTORS_FILE), Buffer.alloc(0))
    const index = new SearchIndex(config)
    const loaded = await index.init()
    assert.equal(loaded.status, 'stale')
  } finally {
    await ws.cleanup()
  }
})

test('persist: empty directory is reported as empty status', async () => {
  const ws = await makeWorkspace({})
  try {
    const index = new SearchIndex(testConfig(ws.root))
    const loaded = await index.init()
    assert.equal(loaded.status, 'empty')
    assert.equal(index.ready, false)
  } finally {
    await ws.cleanup()
  }
})

/**
 * Persistence tests: round-trip through the on-disk index, and staleness
 * handling when the provider/dimension no longer matches.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FORMAT_VERSION, INDEX_FILE, VECTORS_FILE } from '../src/engine/persist.ts'
import { SearchIndex } from '../src/engine/search.ts'
import { makeWorkspace, testConfig } from './helpers.ts'

async function markPersistedHeaderAsC(dataDir: string): Promise<void> {
  const indexPath = join(dataDir, INDEX_FILE)
  const persisted = JSON.parse(await readFile(indexPath, 'utf8')) as {
    files: Array<{ language: string }>
    chunks: Array<{ language: string; symbol: string }>
  }
  persisted.files[0]!.language = 'c'
  for (const chunk of persisted.chunks) {
    chunk.language = 'c'
    chunk.symbol = ''
  }
  await writeFile(indexPath, JSON.stringify(persisted), 'utf8')
}

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

test('persist/load: refreshes files whose language classification changed', async () => {
  const ws = await makeWorkspace({
    'foo.h': 'class Foo {\npublic:\n  void run();\n};\n',
  })
  try {
    const config = testConfig(ws.root, { autosave: true })
    await new SearchIndex(config).build('full')

    await markPersistedHeaderAsC(config.dataDir)

    const reader = new SearchIndex(config)
    assert.equal((await reader.init()).status, 'loaded')
    const refreshed = await reader.build('refresh')
    assert.equal(refreshed.updated, 1)
    assert.equal(refreshed.unchanged, 0)
    assert.equal((await reader.search('Foo')).hits[0]!.symbol, 'class Foo {')
  } finally {
    await ws.cleanup()
  }
})

test('persist/load: lazy search refreshes stale language metadata', async () => {
  const ws = await makeWorkspace({
    'foo.h': 'class Foo {\npublic:\n  void run();\n};\n',
  })
  try {
    const writerConfig = testConfig(ws.root, { autosave: true, autoIndex: false })
    await new SearchIndex(writerConfig).build('full')
    await markPersistedHeaderAsC(writerConfig.dataDir)

    const readerConfig = testConfig(ws.root, { autosave: false, autoIndex: false })
    const lazyReader = new SearchIndex(readerConfig)
    const lazyResult = await lazyReader.search('Foo')
    assert.equal(lazyResult.hits[0]?.symbol, 'class Foo {')

    const initializedReader = new SearchIndex(readerConfig)
    assert.equal((await initializedReader.init()).status, 'loaded')
    const initializedResult = await initializedReader.search('Foo')
    assert.equal(initializedResult.hits[0]?.symbol, 'class Foo {')
  } finally {
    await ws.cleanup()
  }
})

test('persist/load: lazy refresh preserves zero-chunk records for retained binary files', async () => {
  const ws = await makeWorkspace({ 'empty.txt': 'initial content' })
  try {
    const config = testConfig(ws.root, { autosave: true, autoIndex: false })
    const writer = new SearchIndex(config)
    await writer.build('full')
    await writeFile(join(ws.root, 'empty.txt'), '', 'utf8')
    await writer.reindexFile(join(ws.root, 'empty.txt'))
    await writeFile(join(ws.root, 'empty.txt'), Buffer.from([0]))

    const reader = new SearchIndex(config)
    await reader.search('anything')
    assert.equal((await reader.stats()).files, 1)
    assert.equal((await reader.stats()).chunks, 0)

    const persisted = JSON.parse(await readFile(join(config.dataDir, INDEX_FILE), 'utf8')) as {
      files: Array<{ rel: string }>
    }
    assert.deepEqual(persisted.files.map((file) => file.rel), ['empty.txt'])
  } finally {
    await ws.cleanup()
  }
})

test('persist/load: maxChunks preserves a stale zero-chunk file record', async () => {
  const files: Record<string, string> = { 'api.h': 'class Api {}' }
  for (let i = 0; i < 10; i++) files[`keep-${i}.ts`] = `export const keep${i} = ${i}`
  const ws = await makeWorkspace(files)
  try {
    const writerConfig = testConfig(ws.root, { autosave: true, maxChunks: 20 })
    const writer = new SearchIndex(writerConfig)
    await writer.build('full')

    await writeFile(join(ws.root, 'api.h'), '', 'utf8')
    await writer.reindexFile(join(ws.root, 'api.h'))
    const indexPath = join(writerConfig.dataDir, INDEX_FILE)
    const persisted = JSON.parse(await readFile(indexPath, 'utf8')) as {
      files: Array<{ rel: string; language: string }>
    }
    const staleHeader = persisted.files.find((file) => file.rel === 'api.h')
    assert.ok(staleHeader)
    staleHeader.language = 'c'
    await writeFile(indexPath, JSON.stringify(persisted), 'utf8')

    await writeFile(join(ws.root, 'api.h'), 'class Api { void run(); };', 'utf8')
    const readerConfig = testConfig(ws.root, { autosave: true, maxChunks: 10 })
    const reader = new SearchIndex(readerConfig)
    assert.equal((await reader.init()).status, 'loaded')
    const refreshed = await reader.build('refresh')

    assert.equal(refreshed.truncated, true)
    assert.equal((await reader.stats()).files, 11)
    const afterRefresh = JSON.parse(await readFile(indexPath, 'utf8')) as {
      files: Array<{ rel: string; language: string }>
    }
    assert.equal(afterRefresh.files.find((file) => file.rel === 'api.h')?.language, 'c')
  } finally {
    await ws.cleanup()
  }
})

test('persist/load: canceled pre-mutation lazy refresh retains loaded state', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function keepLoadedIndex() { return true }',
  })
  try {
    const config = testConfig(ws.root, { autosave: true })
    await new SearchIndex(config).build('full')
    const reader = new SearchIndex(config)
    assert.equal((await reader.init()).status, 'loaded')

    let checks = 0
    const signal = {
      get aborted() {
        checks++
        return checks >= 6
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal
    await assert.rejects(reader.search('keepLoadedIndex', { signal }), /aborted/)

    assert.equal(reader.ready, true)
    const internal = reader as unknown as { forceFullRebuild: boolean; needsRefresh: boolean }
    assert.equal(internal.forceFullRebuild, false)
    assert.equal(internal.needsRefresh, true)
    assert.ok((await reader.search('keepLoadedIndex')).count > 0)
  } finally {
    await ws.cleanup()
  }
})

test('persist/load: auto-dimension remains valid after lazy refresh', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function roundTrip() { return 1 }',
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { input?: unknown[] }
    const inputs = Array.isArray(payload.input) ? payload.input : []
    return new Response(
      JSON.stringify({ data: inputs.map(() => ({ embedding: [1, 2, 3] })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const config = testConfig(ws.root, {
      autosave: true,
      autoIndex: false,
      provider: {
        kind: 'openai',
        baseUrl: 'http://embedding.test/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        dimension: 0,
        timeoutMs: 1000,
      },
    })
    await new SearchIndex(config).build('full')
    const reader = new SearchIndex(config)
    await reader.search('roundTrip')

    const persisted = JSON.parse(await readFile(join(config.dataDir, INDEX_FILE), 'utf8')) as {
      meta: { dimension: number }
    }
    assert.equal(persisted.meta.dimension, 3)
    assert.equal((await new SearchIndex(config).init()).status, 'loaded')
  } finally {
    globalThis.fetch = originalFetch
    await ws.cleanup()
  }
})

test('persist/load: full rebuild relearns inferred dimensions but preserves configured dimensions', async () => {
  const autoWs = await makeWorkspace({ 'a.ts': 'export function autoWidth() {}\n' })
  const explicitWs = await makeWorkspace({ 'a.ts': 'export function fixedWidth() {}\n' })
  const originalFetch = globalThis.fetch
  let vectorWidth = 3
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { input?: unknown[] }
    const inputs = Array.isArray(payload.input) ? payload.input : []
    return new Response(
      JSON.stringify({ data: inputs.map(() => ({ embedding: Array(vectorWidth).fill(1) })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const autoConfig = testConfig(autoWs.root, {
      autosave: true,
      autoIndex: false,
      allowFallback: false,
      provider: {
        kind: 'openai',
        baseUrl: 'http://embedding.test/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        dimension: 0,
        timeoutMs: 1000,
      },
    })
    const autoIndex = new SearchIndex(autoConfig)
    await autoIndex.build('full')
    assert.equal(autoIndex.dimension, 3)
    vectorWidth = 4
    await autoIndex.build('full')
    assert.equal(autoIndex.dimension, 4)
    const persisted = JSON.parse(await readFile(join(autoConfig.dataDir, INDEX_FILE), 'utf8')) as {
      meta: { dimension: number }
    }
    assert.equal(persisted.meta.dimension, 4)

    const explicitConfig = testConfig(explicitWs.root, {
      autosave: false,
      autoIndex: false,
      allowFallback: false,
      provider: {
        kind: 'openai',
        baseUrl: 'http://embedding.test/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        dimension: 4,
        timeoutMs: 1000,
      },
    })
    vectorWidth = 4
    const explicitIndex = new SearchIndex(explicitConfig)
    await explicitIndex.build('full')
    vectorWidth = 5
    await assert.rejects(explicitIndex.build('full'), /dimension/i)
    assert.equal(explicitIndex.dimension, 4)
  } finally {
    globalThis.fetch = originalFetch
    await autoWs.cleanup()
    await explicitWs.cleanup()
  }
})

test('persist: rejects a non-empty index while the embedding dimension is unknown', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function hasUnknownDimension() { return true }',
  })
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')

    const internal = index as unknown as { provider: { dimension: number } }
    internal.provider.dimension = 0

    await assert.rejects(index.persist(), /embedding dimension is known/)
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

test('persist/load: empty auto-dimension legacy fallback does not lock future vectors', async () => {
  const ws = await makeWorkspace({})
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { input?: unknown[] }
    const inputs = Array.isArray(payload.input) ? payload.input : []
    return new Response(
      JSON.stringify({ data: inputs.map(() => ({ embedding: [1, 2, 3] })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const config = testConfig(ws.root, {
      autosave: true,
      autoIndex: false,
      allowFallback: false,
      provider: {
        kind: 'openai',
        baseUrl: 'http://embedding.test/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        dimension: 0,
        timeoutMs: 1000,
      },
    })
    await new SearchIndex(config).build('full')
    const indexPath = join(config.dataDir, INDEX_FILE)
    const persisted = JSON.parse(await readFile(indexPath, 'utf8')) as { meta: { dimension: number } }
    persisted.meta.dimension = 1024
    await writeFile(indexPath, JSON.stringify(persisted), 'utf8')

    const reader = new SearchIndex(config)
    assert.equal((await reader.init()).status, 'loaded')
    await writeFile(join(ws.root, 'added.ts'), 'export function addedLater() { return true }', 'utf8')
    assert.ok((await reader.search('addedLater')).count > 0)

    const refreshed = JSON.parse(await readFile(indexPath, 'utf8')) as { meta: { dimension: number } }
    assert.equal(refreshed.meta.dimension, 3)
  } finally {
    globalThis.fetch = originalFetch
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

test('persist/load: indexes without decoded-byte metadata are invalidated and rebuilt', async () => {
  const ws = await makeWorkspace({
    'a.txt': 'shared alpha',
  })
  try {
    const config = testConfig(ws.root, { autosave: true })
    await new SearchIndex(config).build('full')

    const indexPath = join(config.dataDir, INDEX_FILE)
    const persisted = JSON.parse(await readFile(indexPath, 'utf8')) as {
      meta: { version: number }
      files: Array<Record<string, unknown>>
    }
    persisted.meta.version = FORMAT_VERSION - 1
    for (const file of persisted.files) delete file.contentBytes
    await writeFile(indexPath, JSON.stringify(persisted), 'utf8')

    const reader = new SearchIndex(config)
    const loaded = await reader.init()
    assert.equal(loaded.status, 'stale')
    assert.match(loaded.reason ?? '', /format/i)

    const rebuilt = await reader.build('refresh')
    assert.equal(rebuilt.mode, 'full')
    const updated = JSON.parse(await readFile(indexPath, 'utf8')) as {
      meta: { version: number }
      files: Array<{ contentBytes: number }>
    }
    assert.equal(updated.meta.version, FORMAT_VERSION)
    assert.equal(updated.files[0]?.contentBytes, Buffer.byteLength('shared alpha', 'utf8'))
  } finally {
    await ws.cleanup()
  }
})

test('persist: removeFile saves an empty index after deleting the last file', async () => {
  const ws = await makeWorkspace({
    'a.txt': 'last file',
  })
  try {
    const config = testConfig(ws.root, { autosave: true })
    const index = new SearchIndex(config)
    await index.build('full')

    await rm(join(ws.root, 'a.txt'))
    await index.removeFile(join(ws.root, 'a.txt'))

    const reader = new SearchIndex(config)
    const loaded = await reader.init()
    assert.equal(loaded.status, 'loaded')
    const stats = await reader.stats()
    assert.equal(stats.files, 0)
    assert.equal(stats.chunks, 0)
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

test('persist failure is surfaced through the log, not only the errors array', async () => {
  const ws = await makeWorkspace({ 'a.ts': 'export const x = 1' })
  try {
    // occupy the dataDir path with a regular file so the persist write fails
    writeFileSync(join(ws.root, '.sema'), 'not a directory')
    const logged: string[] = []
    const index = new SearchIndex(testConfig(ws.root, { autosave: true }), {
      error: (msg) => logged.push(String(msg)),
    })
    await index.build('full')
    const stats = await index.stats()
    assert.ok(stats.errors.some((e) => e.includes('persist failed')))
    assert.ok(logged.some((e) => e.includes('persist failed')))
  } finally {
    await ws.cleanup()
  }
})

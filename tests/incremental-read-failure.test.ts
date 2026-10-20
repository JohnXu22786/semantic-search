import assert from 'node:assert/strict'
import * as fsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { makeWorkspace, testConfig } from './helpers.ts'

const originalReadFile = fsPromises.readFile
const originalReaddir = fsPromises.readdir
let readFailurePath: string | undefined
let readdirFailurePath: string | undefined
let persistentReaddirFailurePath: string | undefined

const injectedReadFile = async (...args: Parameters<typeof fsPromises.readFile>) => {
  if (readFailurePath === args[0].toString()) {
    readFailurePath = undefined
    throw new Error('injected read failure')
  }
  return originalReadFile(...args)
}

const injectedReaddir = async (...args: Parameters<typeof fsPromises.readdir>) => {
  if (persistentReaddirFailurePath === args[0].toString()) {
    throw new Error('injected persistent directory read failure')
  }
  if (readdirFailurePath === args[0].toString()) {
    readdirFailurePath = undefined
    throw new Error('injected directory read failure')
  }
  return originalReaddir(...args)
}

mock.module('node:fs/promises', {
  namedExports: {
    ...fsPromises,
    readFile: injectedReadFile,
    readdir: injectedReaddir,
  },
})

const { SearchIndex } = await import('../src/engine/search.ts')

test('refresh: read failures on loaded records block additions when decoded size is unknown', async () => {
  const ws = await makeWorkspace({})
  const filePath = join(ws.root, 'a.ts')
  try {
    await fsPromises.writeFile(filePath, Buffer.concat([
      Buffer.from('export function preserveMe() {}\n'),
      Buffer.alloc(1024, 0x80),
    ]))
    const config = testConfig(ws.root, { maxTotalBytes: 3500, autosave: true })
    await new SearchIndex(config).build('full')

    const index = new SearchIndex(config)
    assert.equal((await index.init()).status, 'loaded')
    await fsPromises.writeFile(filePath, 'replacement content with changed size', 'utf8')
    readFailurePath = filePath
    await fsPromises.writeFile(join(ws.root, 'new.txt'), 'n'.repeat(600), 'utf8')

    const result = await index.build('refresh')
    assert.ok(result.errors.some((error) => error.includes('injected read failure')))
    assert.equal(result.truncated, true)
    assert.equal(result.added, 0)
    assert.equal((await index.stats()).files, 1)
    assert.ok((await index.search('preserveMe')).hits.some((hit) => hit.file === 'a.ts'))
  } finally {
    mock.reset()
    await ws.cleanup()
  }
})

test('lazy refresh retries a changed file after a read failure', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function preserveMe() {}\n',
  })
  const filePath = join(ws.root, 'a.ts')
  try {
    const writerConfig = testConfig(ws.root, { autosave: true, autoIndex: false })
    await new SearchIndex(writerConfig).build('full')

    await fsPromises.writeFile(filePath, 'export function replacementSymbol() {}\n', 'utf8')
    readFailurePath = filePath
    const reader = new SearchIndex(testConfig(ws.root, { autosave: false, autoIndex: false }))
    const staleResult = await reader.search('preserveMe')
    assert.ok(staleResult.hits.some((hit) => hit.symbol.includes('preserveMe')))

    const refreshedResult = await reader.search('replacementSymbol')
    assert.ok(refreshedResult.hits.some((hit) => hit.symbol.includes('replacementSymbol')))
    const staleResultAfterRetry = await reader.search('preserveMe')
    assert.equal(staleResultAfterRetry.hits.some((hit) => hit.symbol.includes('preserveMe')), false)
  } finally {
    mock.reset()
    await ws.cleanup()
  }
})

test('lazy refresh retries after a scanner directory read failure', async () => {
  const ws = await makeWorkspace({
    'src/a.ts': 'export function preserveMe() {}\n',
  })
  const filePath = join(ws.root, 'src/a.ts')
  try {
    const writerConfig = testConfig(ws.root, { autosave: true, autoIndex: false })
    await new SearchIndex(writerConfig).build('full')

    await fsPromises.writeFile(filePath, 'export function replacementSymbol() {}\n', 'utf8')
    readdirFailurePath = join(ws.root, 'src')
    const reader = new SearchIndex(testConfig(ws.root, { autosave: false, autoIndex: false }))

    const staleResult = await reader.search('preserveMe')
    assert.ok(staleResult.hits.some((hit) => hit.symbol.includes('preserveMe')))

    const refreshedResult = await reader.search('replacementSymbol')
    assert.ok(refreshedResult.hits.some((hit) => hit.symbol.includes('replacementSymbol')))
    const staleResultAfterRetry = await reader.search('preserveMe')
    assert.equal(staleResultAfterRetry.hits.some((hit) => hit.symbol.includes('preserveMe')), false)
  } finally {
    mock.reset()
    await ws.cleanup()
  }
})

test('lazy refresh does not duplicate repeated persistent scanner errors', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function preserveMe() {}\n',
  })
  try {
    const writerConfig = testConfig(ws.root, { autosave: true, autoIndex: false })
    await new SearchIndex(writerConfig).build('full')

    const reader = new SearchIndex(testConfig(ws.root, { autosave: false, autoIndex: false }))
    persistentReaddirFailurePath = ws.root

    const first = await reader.search('preserveMe')
    assert.ok(first.hits.some((hit) => hit.symbol.includes('preserveMe')))
    const firstErrorCount = (await reader.stats()).errors.filter((error) => error.includes('injected persistent directory read failure')).length

    const second = await reader.search('preserveMe')
    assert.ok(second.hits.some((hit) => hit.symbol.includes('preserveMe')))
    const secondErrorCount = (await reader.stats()).errors.filter((error) => error.includes('injected persistent directory read failure')).length

    assert.equal(firstErrorCount, 1)
    assert.equal(secondErrorCount, 1)
  } finally {
    persistentReaddirFailurePath = undefined
    mock.reset()
    await ws.cleanup()
  }
})

test('lazy read failures preserve the loaded index when re-embedding is unavailable', async () => {
  const ws = await makeWorkspace({
    'a.ts': 'export function preserveMe() {}\n',
  })
  const filePath = join(ws.root, 'a.ts')
  try {
    const writerConfig = testConfig(ws.root, { autosave: true, autoIndex: false })
    await new SearchIndex(writerConfig).build('full')

    const reader = new SearchIndex(testConfig(ws.root, {
      autosave: false,
      autoIndex: false,
      allowFallback: false,
    }))
    assert.equal((await reader.init()).status, 'loaded')
    await fsPromises.writeFile(filePath, 'export function replacementSymbol() {}\n', 'utf8')
    readFailurePath = filePath

    const internal = reader as unknown as { provider: unknown }
    const originalProvider = internal.provider
    internal.provider = {
      id: 'openai:unavailable',
      kind: 'openai',
      dimension: 256,
      local: false,
      embed: async () => { throw new Error('injected provider failure') },
    }
    await reader.search('preserveMe')
    assert.equal(reader.ready, true)

    internal.provider = originalProvider
    const refreshed = await reader.search('replacementSymbol')
    assert.ok(refreshed.hits.some((hit) => hit.symbol.includes('replacementSymbol')))
  } finally {
    mock.reset()
    await ws.cleanup()
  }
})

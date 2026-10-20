import assert from 'node:assert/strict'
import * as fsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { makeWorkspace, testConfig } from './helpers.ts'

const originalReadFile = fsPromises.readFile
let readFailurePath: string | undefined

const injectedReadFile = async (...args: Parameters<typeof fsPromises.readFile>) => {
  if (readFailurePath === args[0].toString()) {
    readFailurePath = undefined
    throw new Error('injected read failure')
  }
  return originalReadFile(...args)
}

mock.module('node:fs/promises', {
  namedExports: {
    ...fsPromises,
    readFile: injectedReadFile,
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

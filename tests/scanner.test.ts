import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanWorkspace } from '../src/engine/scanner.ts'
import { makeWorkspace } from './helpers.ts'

test('scan: enforces maxTotalBytes using UTF-8 byte length', async () => {
  const ws = await makeWorkspace({ 'notes.txt': '中'.repeat(1024) })
  try {
    const result = await scanWorkspace({
      root: ws.root,
      include: ['*.txt'],
      ignore: [],
      maxFileBytes: 4096,
      maxFiles: 10,
      maxTotalBytes: 1024,
    })

    assert.deepEqual(result.files, [])
    assert.equal(result.truncated, true)
  } finally {
    await ws.cleanup()
  }
})

test('scan: **/*.ts includes files directly under the workspace root', async () => {
  const ws = await makeWorkspace({
    'root.ts': 'export const root = true\n',
    'nested/file.ts': 'export const nested = true\n',
  })
  try {
    const result = await scanWorkspace({
      root: ws.root,
      include: ['**/*.ts'],
      ignore: [],
      maxFileBytes: 4096,
      maxFiles: 10,
      maxTotalBytes: 4096,
    })

    assert.deepEqual(
      result.files.map((file) => file.rel).sort(),
      ['nested/file.ts', 'root.ts'],
    )
  } finally {
    await ws.cleanup()
  }
})

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

test('metadata-only scans enforce maxTotalBytes and report truncation', async () => {
  const ws = await makeWorkspace({
    'a.txt': 'aaaa',
    'b.txt': 'bbbb',
  })
  try {
    const result = await scanWorkspace({
      root: ws.root,
      include: ['*.txt'],
      ignore: [],
      maxFileBytes: 1024,
      maxFiles: 10,
      maxTotalBytes: 5,
      readContent: false,
    })

    assert.deepEqual(result.files.map((file) => file.rel), ['a.txt'])
    assert.equal(result.truncated, true)
  } finally {
    await ws.cleanup()
  }
})

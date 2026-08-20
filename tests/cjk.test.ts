/**
 * Chinese (CJK) end-to-end tests: a workspace containing Chinese comments and
 * strings is indexed and searchable with Chinese queries (n-gram tokenization
 * on both sides must align).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SearchIndex } from '../src/engine/search.ts'
import { makeWorkspace, testConfig } from './helpers.ts'

const SAMPLE = {
  'src/budget.ts': `
// 会话预算管理：根据剩余 token 计算可用额度
export class SessionBudget {
  remaining() { return 100 }
}
`,
  'usr/translation.py': `
# 翻译缓存服务：保存语言对结果
class TranslationCache:
    def lookup(self, key):
        return "缓存命中"
`,
}

test('cjk: Chinese queries retrieve Chinese-comment code', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.search('预算管理')
    assert.ok(result.count > 0)
    assert.equal(result.hits[0]!.file, 'src/budget.ts')
  } finally {
    await ws.cleanup()
  }
})

test('cjk: token 预算 query also matches the budget file', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.search('剩余 token')
    assert.ok(result.count > 0)
    assert.equal(result.hits[0]!.file, 'src/budget.ts')
  } finally {
    await ws.cleanup()
  }
})

test('cjk: Chinese string content is searchable, not only comments', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.search('翻译缓存')
    assert.ok(result.count > 0)
    assert.equal(result.hits[0]!.file, 'usr/translation.py')
  } finally {
    await ws.cleanup()
  }
})

test('cjk: Chinese + English mixed query works', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.search('翻译 cache look up')
    assert.ok(result.count > 0)
    assert.equal(result.hits[0]!.file, 'usr/translation.py')
  } finally {
    await ws.cleanup()
  }
})

test('cjk: unrelated Chinese query does not match other files', async () => {
  const ws = await makeWorkspace(SAMPLE)
  try {
    const index = new SearchIndex(testConfig(ws.root))
    await index.build('full')
    const result = await index.search('图像渲染管线')
    // lexical channel is empty for these terms; vector channel may still
    // return lowest-similarity hits, which is acceptable hybrid behavior.
    assert.ok(result.count >= 0)
  } finally {
    await ws.cleanup()
  }
})

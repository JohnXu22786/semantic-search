/**
 * Tokenizer tests: Latin identifiers (camel/snake/kebab), numbers, and CJK
 * n-gram handling. Guards against regressions in query/doc token parity — the
 * whole field of a lexical search depends on it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { containsCjk, termFrequencies, tokenTypes, tokenize } from '../src/engine/tokenizer.ts'

test('tokenize: splits camelCase identifiers into words', () => {
  assert.deepEqual(tokenize('getTotalAmount'), ['get', 'total', 'amount'])
})

test('tokenize: handles acronym boundaries', () => {
  assert.deepEqual(tokenize('XMLHttpRequest'), ['xml', 'http', 'request'])
  assert.deepEqual(tokenize('parseURL'), ['parse', 'url'])
})

test('tokenize: snake_case and kebab-case separate naturally', () => {
  assert.deepEqual(tokenize('max_retry_count'), ['max', 'retry', 'count'])
  assert.deepEqual(tokenize('file-name'), ['file', 'name'])
})

test('tokenize: lowercases and strips punctuation/operators', () => {
  assert.deepEqual(tokenize('Foo.Bar(); ->'), ['foo', 'bar'])
  assert.deepEqual(tokenize('a+b*c'), ['a', 'b', 'c'])
})

test('tokenize: keeps numeric parts', () => {
  assert.deepEqual(tokenize('timeout500ms'), ['timeout500ms'])
})

test('tokenize: CJK runs become sliding bigrams by default', () => {
  assert.deepEqual(tokenize('语义搜索'), ['语义', '义搜', '搜索'])
})

test('tokenize: short CJK runs are kept whole', () => {
  assert.deepEqual(tokenize('配置'), ['配置'])
})

test('tokenize: ngram=1 keeps single characters', () => {
  // length-2 run at ngram=1 → two unigram tokens
  assert.deepEqual(tokenize('语义', 1), ['语', '义'])
})

test('tokenize: mixed Chinese + Latin stays consistent', () => {
  assert.deepEqual(tokenize('连接database'), ['连接', 'database'])
  assert.deepEqual(tokenize('语义搜索引擎'), ['语义', '义搜', '搜索', '索引', '引擎'])
})

test('tokenize: empty and whitespace-only input yields nothing', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize('   \n\t '), [])
})

test('tokenTypes: deduplicates', () => {
  assert.deepEqual(tokenTypes('foo foo bar').sort(), ['bar', 'foo'])
})

test('termFrequencies: counts occurrences', () => {
  const tf = termFrequencies('foo bar foo')
  assert.equal(tf.get('foo'), 2)
  assert.equal(tf.get('bar'), 1)
  assert.equal(tf.size, 2)
})

test('containsCjk: detects CJK and ignores Latin', () => {
  assert.equal(containsCjk('hello world'), false)
  assert.equal(containsCjk('搜索'), true)
  assert.equal(containsCjk('日本語'), true)
  assert.equal(containsCjk('한국어'), true)
})

test('tokenize: ignores non-alphanumeric CJK punctuation as boundaries', () => {
  assert.deepEqual(tokenize('你好，世界！'), ['你好', '好世', '世界'])
})

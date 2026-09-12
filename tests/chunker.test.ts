/**
 * Chunker tests: symbol-aware boundaries (multi-language), line caps, plain-text
 * fallback, and summary selection.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, pickSummary } from '../src/engine/chunker.ts'
import { languageForPath } from '../src/engine/languages.ts'

test('chunkText: empty file returns no chunks', () => {
  assert.deepEqual(chunkText('', null, { maxLines: 80 }), [])
})

test('chunkText: javascript file splits at function/class boundaries', () => {
  const src = [
    'const helper = () => {}',
    '',
    'export class Calculator {',
    '  multiply(x, y) { return x * y }',
    '}',
    '',
    'export function add(a, b) {',
    '  return a + b',
    '}',
  ].join('\n')
  const lang = languageForPath('a.ts')
  const chunks = chunkText(src, lang, { maxLines: 80 })
  assert.ok(chunks.length >= 3)
  const symbols = chunks.map((c) => c.symbol)
  assert.ok(symbols.some((s) => s.includes('Calculator')), `expected Calculator boundary, got ${symbols}`)
  assert.ok(symbols.some((s) => s.includes('add')), `expected add boundary, got ${symbols}`)
  assert.ok(symbols.some((s) => s.includes('helper')), `expected helper boundary, got ${symbols}`)
  // lines stay 1-based and contiguous
  for (const chunk of chunks) {
    assert.ok(chunk.startLine >= 1)
    assert.ok(chunk.endLine >= chunk.startLine)
    assert.ok(chunk.content.length > 0)
  }
})

test('chunkText: python file recognises def/class', () => {
  const src = [
    'import os',
    '',
    'def parse_config(path):',
    '    return os.path.realpath(path)',
    '',
    'class Database:',
    '    def connect(self):',
    '        return None',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('db.py'), { maxLines: 80 })
  const symbols = chunks.flatMap((c) => [c.symbol])
  assert.ok(symbols.some((s) => s.startsWith('def parse_config')), `got ${symbols}`)
  assert.ok(symbols.some((s) => s.startsWith('class Database')), `got ${symbols}`)
  assert.ok(symbols.some((s) => s.startsWith('def connect')), `got ${symbols}`)
})

test('chunkText: C++ header file recognises class declarations', () => {
  const src = ['#pragma once', '', 'class Foo {', 'public:', '  void run();', '};'].join('\n')
  const lang = languageForPath('foo.h')
  assert.equal(lang?.name, 'cpp')
  const chunks = chunkText(src, lang, { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'class Foo {'), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('languageForPath: C source files still use the C definition', () => {
  assert.equal(languageForPath('foo.c')?.name, 'c')
})

test('chunkText: large function is split at maxLines without losing content', () => {
  const body: string[] = []
  for (let i = 0; i < 40; i++) body.push(`  line_${i} = ${i}`)
  const src = ['function big() {', ...body, '}'].join('\n')
  const chunks = chunkText(src, languageForPath('big.js'), { maxLines: 10 })
  assert.ok(chunks.length >= 4)
  for (const chunk of chunks) {
    const lineCount = chunk.content.split('\n').length
    assert.ok(lineCount <= 10, `chunk exceeded maxLines: ${lineCount}`)
  }
  // no content lost across chunks
  const joined = chunks.map((c) => c.content).join('\n')
  assert.ok(joined.includes('line_0 = 0'))
  assert.ok(joined.includes('line_39 = 39'))
})

test('chunkText: unknown language falls back to plain text chunks', () => {
  const src = Array.from({ length: 25 }, (_, i) => `row ${i}`).join('\n')
  const chunks = chunkText(src, null, { maxLines: 10 })
  assert.ok(chunks.length >= 3)
  for (const chunk of chunks) assert.equal(chunk.symbol, '')
})

test('chunkText: normalize CRLF and record 1-based lines', () => {
  const src = 'a\r\nb\r\nc'
  const chunks = chunkText(src, null, { maxLines: 10 })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]!.content, 'a\nb\nc')
  assert.equal(chunks[0]!.startLine, 1)
  assert.equal(chunks[0]!.endLine, 3)
})

test('pickSummary: uses the symbol header when present', () => {
  const summary = pickSummary(['  export function add(a, b) {', '    ...'], 'export function add(a, b) {', languageForPath('x.ts'))
  assert.equal(summary, 'export function add(a, b) {')
})

test('pickSummary: skips comments and blanks for plain chunks', () => {
  const lang = languageForPath('x.ts')
  const summary = pickSummary(['', '// a comment', 'const x = 1'], '', lang)
  assert.equal(summary, 'const x = 1')
})

test('pickSummary: python comments are skipped', () => {
  const lang = languageForPath('x.py')
  assert.equal(pickSummary(['# note', 'value = 42'], '', lang), 'value = 42')
})

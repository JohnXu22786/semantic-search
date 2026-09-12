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

test('chunkText: clears a completed function before unrelated top-level code', () => {
  const src = ['function f() {}', 'const unrelated = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.symbol, 'function f() {}')
  assert.equal(chunks[1]!.content, 'const unrelated = 1')
  assert.equal(chunks[1]!.symbol, '')
})

test('chunkText: ignores braces in comments, templates, and regexes', () => {
  const src = [
    'function scan() {',
    '  /* }',
    '     still in a comment */',
    '  const template = `literal }',
    '    still {`;',
    '  const pattern = /}/;',
    '  return pattern.test(template)',
    '}',
    'const unrelated = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.symbol, 'function scan() {')
  assert.ok(chunks[0]!.content.includes('return pattern.test(template)'))
  assert.equal(chunks[1]!.content, 'const unrelated = 1')
  assert.equal(chunks[1]!.symbol, '')
})

test('chunkText: restores the enclosing symbol after a nested symbol ends', () => {
  const src = [
    'function outer() {',
    '  function inner() {}',
    '  return 1',
    '}',
    'const unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })

  assert.equal(chunks[0]!.symbol, 'function outer() {')
  assert.equal(chunks[1]!.symbol, 'function inner() {}')
  const outerRemainder = chunks.find((chunk) => chunk.content.includes('return 1'))
  assert.ok(outerRemainder)
  assert.equal(outerRemainder!.symbol, 'function outer() {')
  const unrelated = chunks.find((chunk) => chunk.content === 'const unrelated = 2')
  assert.ok(unrelated)
  assert.equal(unrelated!.symbol, '')
})

test('chunkText: clears brace-less expression-bodied symbols', () => {
  const cases = [
    ['a.js', 'const f = () => 1', 'const unrelated = 1'],
    ['a.kt', 'fun f() = 1', 'val unrelated = 2'],
    ['a.scala', 'def f = 1', 'val unrelated = 2'],
  ] as const

  for (const [path, declaration, unrelatedLine] of cases) {
    const chunks = chunkText(`${declaration}\n${unrelatedLine}`, languageForPath(path), { maxLines: 80 })
    assert.equal(chunks.length, 2, path)
    assert.equal(chunks[0]!.symbol, declaration, path)
    assert.equal(chunks[1]!.content, unrelatedLine, path)
    assert.equal(chunks[1]!.symbol, '', path)
  }
})

test('chunkText: clears multiline expression bodies and type aliases', () => {
  const cases = [
    ['a.js', ['const f = () =>', '  1', 'const unrelated = 1']],
    ['a.kt', ['fun f() =', '  1', 'val unrelated = 2']],
    ['a.ts', ['type Name = string', 'const unrelated = 3']],
  ] as const

  for (const [path, lines] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    assert.equal(chunks.length, 2, path)
    assert.equal(chunks[0]!.symbol, lines[0], path)
    assert.equal(chunks[1]!.content, lines.at(-1), path)
    assert.equal(chunks[1]!.symbol, '', path)
  }
})

test('chunkText: recognizes regex literals after closing parens and braces', () => {
  const src = [
    'function check(value) {',
    '  if (value) /}/.test(value)',
    '  const object = {}',
    '  /}/.test(object)',
    '  return value',
    '}',
    'const unrelated = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.symbol, 'function check(value) {')
  assert.ok(chunks[0]!.content.includes('return value'))
  assert.equal(chunks[1]!.symbol, '')
})

test('chunkText: preserves nested template literal state', () => {
  const src = [
    'function render() {',
    '  const value = `${`}`}`',
    '  return value',
    '}',
    'const unrelated = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.symbol, 'function render() {')
  assert.ok(chunks[0]!.content.includes('return value'))
  assert.equal(chunks[1]!.symbol, '')
})

test('chunkText: ignores hash comments for Bash and PHP', () => {
  const cases = [
    ['a.sh', ['function f() {', '  # }', '  echo ok', '}', 'echo unrelated']],
    ['a.php', ['function f() {', '  # }', '  return 1;', '}', '$unrelated = 2;']],
  ] as const

  for (const [path, lines] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    assert.equal(chunks.length, 2, path)
    assert.equal(chunks[0]!.symbol, lines[0], path)
    assert.equal(chunks[1]!.content, lines.at(-1), path)
    assert.equal(chunks[1]!.symbol, '', path)
  }
})

test('chunkText: preserves nested block-comment state', () => {
  const cases = [
    ['a.rs', ['fn f() {', '  /* outer {', '     /* nested } */', '     still outer } */', '  1', '}', 'let unrelated = 2']],
    ['a.kt', ['fun f() {', '  /* outer {', '     /* nested } */', '     still outer } */', '  1', '}', 'val unrelated = 2']],
    ['a.swift', ['func f() {', '  /* outer {', '     /* nested } */', '     still outer } */', '  1', '}', 'let unrelated = 2']],
  ] as const

  for (const [path, lines] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    assert.equal(chunks.length, 2, path)
    assert.equal(chunks[0]!.symbol, lines[0], path)
    assert.equal(chunks[1]!.content, lines.at(-1), path)
    assert.equal(chunks[1]!.symbol, '', path)
  }
})

test('chunkText: ends Python and Ruby symbols at their language scope', () => {
  const cases = [
    ['a.py', ['def f():', '    return 1', 'unrelated = 2']],
    ['a.rb', ['def f', '  1', 'end', 'unrelated = 2']],
  ] as const

  for (const [path, lines] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    assert.equal(chunks.length, 2, path)
    assert.equal(chunks[0]!.symbol, lines[0], path)
    assert.equal(chunks[1]!.content, lines.at(-1), path)
    assert.equal(chunks[1]!.symbol, '', path)
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

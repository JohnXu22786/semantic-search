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

test('chunkText: parentheses in JavaScript parameter comments do not hide the function body', () => {
  const src = ['function f(/* ) */) { return 1; }', 'outside();'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside();'))
  assert.equal(body?.symbol, 'function f(/* ) */) { return 1; }')
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript parameter scans skip template and regex literals', () => {
  const cases = [
    'function f(value = `)`) { return 1; }',
    'function f(value = /)/) { return 1; }',
  ]

  for (const declaration of cases) {
    const src = [declaration, 'outside()'].join('\n')
    const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
    const body = chunks.find((chunk) => chunk.content.includes('return 1'))
    const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
    assert.equal(body?.symbol, declaration, declaration)
    assert.ok(outside, declaration)
    assert.equal(outside!.symbol, '', declaration)
  }
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
    '  const object = {};',
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

test('chunkText: hash characters inside Bash words are not comments', () => {
  const src = ['function f() { echo foo#bar; }', 'outside=1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('echo foo#bar'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside=1'))
  assert.equal(body?.symbol, 'function f() { echo foo#bar; }')
  assert.equal(outside?.symbol, '')
})

test('chunkText: preserves nested block-comment state', () => {
  const cases = [
    ['a.rs', ['fn f() {', '  /* outer {', '     /* nested } */', '     still outer } */', '  1', '}', 'fn unrelated() {}'], 'fn unrelated() {}'],
    ['a.kt', ['fun f() {', '  /* outer {', '     /* nested } */', '     still outer } */', '  1', '}', 'val unrelated = 2'], ''],
    ['a.swift', ['func f() {', '  /* outer {', '     /* nested } */', '     still outer } */', '  1', '}', 'let unrelated = 2'], ''],
  ] as const

  for (const [path, lines, expectedOutsideSymbol] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    assert.equal(chunks.length, 2, path)
    assert.equal(chunks[0]!.symbol, lines[0], path)
    assert.equal(chunks[1]!.content, lines.at(-1), path)
    assert.equal(chunks[1]!.symbol, expectedOutsideSymbol, path)
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

test('chunkText: keeps Bash parameter expansion braces balanced', () => {
  const src = [
    'function f() {',
    '  echo ${var#prefix}',
    '}',
    'echo unrelated',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.symbol, 'function f() {')
  assert.ok(chunks[0]!.content.includes('echo ${var#prefix}'))
  assert.equal(chunks[1]!.content, 'echo unrelated')
  assert.equal(chunks[1]!.symbol, '')
})

test('chunkText: Bash braces attached to words do not change function scope', () => {
  for (const command of ['echo literal{', 'echo literal}']) {
    const src = [
      'function f() {',
      `  ${command}`,
      '  echo still_in_f',
      '}',
      'outside()',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
    const body = chunks.find((chunk) => chunk.content.includes('still_in_f'))
    const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
    assert.equal(body?.symbol, 'function f() {', command)
    assert.equal(outside?.symbol, '', command)
  }
})

test('chunkText: keeps a Python body after a definition comment labeled', () => {
  const src = ['def f(): # comment', '    return 1', 'unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.symbol, 'def f(): # comment')
  assert.ok(chunks[0]!.content.includes('return 1'))
  assert.equal(chunks[1]!.content, 'unrelated = 2')
  assert.equal(chunks[1]!.symbol, '')
})

test('chunkText: hashes inside Python triple-quoted defaults do not truncate headers', () => {
  const src = ['def f(value: str = """#"""): return value', 'unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })
  const unrelated = chunks.find((chunk) => chunk.content.includes('unrelated = 2'))
  assert.equal(chunks[0]?.symbol, 'def f(value: str = """#"""): return value')
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: ignores column-zero Python comments when ending indentation scopes', () => {
  const src = ['def f():', '# comment', '    return 1', 'unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.symbol, 'def f():')
  assert.ok(chunks[0]!.content.includes('# comment'))
  assert.ok(chunks[0]!.content.includes('return 1'))
  assert.equal(chunks[1]!.symbol, '')
})

test('chunkText: Python comments follow indentation scope boundaries', () => {
  const moduleSrc = ['def f():', '    return 1', '# module comment', 'x = 2'].join('\n')
  const moduleChunks = chunkText(moduleSrc, languageForPath('a.py'), { maxLines: 80 })
  const moduleComment = moduleChunks.find((chunk) => chunk.content.includes('# module comment'))
  const moduleCode = moduleChunks.find((chunk) => chunk.content.includes('x = 2'))
  assert.equal(moduleComment?.symbol, '')
  assert.equal(moduleCode?.symbol, '')

  const suiteSrc = ['def g():', '    return 1', '    # suite comment', '    after = 2', 'outside = 3'].join('\n')
  const suiteChunks = chunkText(suiteSrc, languageForPath('a.py'), { maxLines: 80 })
  const suiteComment = suiteChunks.find((chunk) => chunk.content.includes('# suite comment'))
  assert.equal(suiteComment?.symbol, 'def g():')
})

test('chunkText: keeps Python multiline signatures labeled through their body', () => {
  const src = ['def f(', '    value,', '):', '    return value', 'unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.symbol, 'def f(')
  assert.ok(chunks[0]!.content.includes('return value'))
  assert.equal(chunks[1]!.content, 'unrelated = 2')
  assert.equal(chunks[1]!.symbol, '')
})

test('chunkText: does not use indentation to end multiline expression bodies', () => {
  const cases = [
    ['a.js', ['const f = () =>', '1', 'const unrelated = 1']],
    ['a.kt', ['fun f() =', '1', 'val unrelated = 2']],
    ['a.scala', ['def f =', '1', 'val unrelated = 2']],
  ] as const

  for (const [path, lines] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    assert.equal(chunks.length, 2, path)
    assert.equal(chunks[0]!.symbol, lines[0], path)
    assert.ok(chunks[0]!.content.includes(`\n${lines[1]}`), path)
    assert.equal(chunks[1]!.content, lines[2], path)
    assert.equal(chunks[1]!.symbol, '', path)
  }
})

test('chunkText: ends bodyless Kotlin, Scala, and Swift declarations', () => {
  const cases = [
    ['a.kt', ['interface Api {', '  fun run()', '}', 'val unrelated = 1'], 'fun run()'],
    ['a.scala', ['trait Api {', '  def run(): Unit', '}', 'val unrelated = 2'], 'def run(): Unit'],
    ['a.swift', ['protocol Api {', '  func run()', '}', 'let unrelated = 3'], 'func run()'],
  ] as const

  for (const [path, lines, declaration] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    const method = chunks.find((chunk) => chunk.content.includes(declaration))
    const unrelated = chunks.find((chunk) => chunk.content === lines[3])
    assert.equal(method?.symbol, declaration, path)
    assert.ok(unrelated, path)
    assert.equal(unrelated!.symbol, '', path)
  }
})

test('chunkText: bodyless Kotlin classes end before following declarations', () => {
  const bodyless = chunkText('class Empty\nval unrelated = 1', languageForPath('a.kt'), { maxLines: 80 })
  const unrelated = bodyless.find((chunk) => chunk.content.includes('val unrelated = 1'))
  assert.equal(unrelated?.symbol, '')

  const withBody = chunkText(
    ['class Example', '{', '  val member = 1', '}', 'val unrelated = 2'].join('\n'),
    languageForPath('a.kt'),
    { maxLines: 80 },
  )
  const member = withBody.find((chunk) => chunk.content.includes('val member = 1'))
  const after = withBody.find((chunk) => chunk.content.includes('val unrelated = 2'))
  assert.equal(member?.symbol, 'class Example')
  assert.equal(after?.symbol, '')
})

test('chunkText: Swift bodyless dictionary requirements with where clauses end at protocol boundary', () => {
  const src = [
    'protocol API {',
    '  func fetch<T: Collection>(_ key: T) -> [String: String] where T.Element == String',
    '}',
    'let unrelated = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const requirement = chunks.find((chunk) => chunk.content.includes('func fetch'))
  const unrelated = chunks.find((chunk) => chunk.content.includes('let unrelated = 1'))
  assert.equal(requirement?.symbol, 'func fetch<T: Collection>(_ key: T) -> [String: String] where T.Element == String')
  assert.ok(unrelated)
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: ignores Ruby postfix conditionals in block depth', () => {
  const src = ['def f', '  value = 1 if condition', '  value', 'end', 'unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.symbol, 'def f')
  assert.ok(chunks[0]!.content.includes('end'))
  assert.equal(chunks[1]!.content, 'unrelated = 2')
  assert.equal(chunks[1]!.symbol, '')
})

test('chunkText: ignores Ruby regex and heredoc contents in block depth', () => {
  const cases = [
    ['def f', '  pattern = /end/', '  1', 'end', 'unrelated = 1'],
    ['def f', '  text = <<~TEXT', '  end', '  TEXT', '  1', 'end', 'unrelated = 2'],
  ] as const

  for (const lines of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath('a.rb'), { maxLines: 80 })
    const unrelated = chunks.find((chunk) => chunk.content === lines.at(-1))
    assert.ok(unrelated, lines[1])
    assert.equal(unrelated!.symbol, '', lines[1])
    assert.ok(chunks.some((chunk) => chunk.content.includes('end') && chunk.symbol === 'def f'), lines[1])
  }
})

test('chunkText: distinguishes division from a following regex literal', () => {
  const src = [
    'function f() {',
    '  ({}) / /}/',
    '  return 1',
    '}',
    'const unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.symbol, 'function f() {')
  assert.ok(chunks[0]!.content.includes('return 1'))
  assert.equal(chunks[1]!.content, 'const unrelated = 2')
  assert.equal(chunks[1]!.symbol, '')
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

test('chunkText: C-compatible header file recognises extern struct declarations', () => {
  const src = ['#pragma once', '', 'extern struct Foo foo;', ''].join('\n')
  const lang = languageForPath('foo.h')
  assert.equal(lang?.name, 'cpp')
  const chunks = chunkText(src, lang, { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'extern struct Foo foo;'), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C-compatible header file recognises extern declarations', () => {
  const src = [
    '#pragma once',
    '',
    'extern int api_init(void);',
    'extern int api_version;',
    'extern int matrix[2][3];',
    'extern int (*matrix_ptr)[3];',
    'extern int(*tight_matrix_ptr)[3];',
    'extern int first, second;',
    'extern void (*callback)(int);',
    'extern "C" char *(*c_callback)(int);',
    'extern "C" char const *(*get_name)(void);',
    'extern "C" int initialized_export = 1;',
    'extern "C" int * const api_handle;',
    'extern "C" int * const *api_handle_chain;',
    'extern "C" int *const *tight_api_handle;',
    'extern "C" void (* const direct_callback)(int);',
    'extern "C" void (*const direct_tight_callback)(int);',
    'extern char *api_name(void);',
    'extern "C" void api_shutdown(void);',
    'extern "C"',
    'int pending_c_api_version;',
    'namespace api {',
    'extern int namespace_api_version;',
    '}',
    'namespace split_api',
    '{',
    'extern int split_namespace_api_version;',
    '}',
    'namespace [[deprecated]] attributed_api',
    '{',
    'extern int attributed_namespace_api_version;',
    '}',
    'namespace nested_api { namespace detail {',
    'extern int nested_namespace_api_version;',
    '} }',
    'namespace c_api { extern "C" {',
    'int namespace_c_api_version;',
    '} }',
    '',
  ].join('\n')
  const lang = languageForPath('foo.h')
  assert.equal(lang?.name, 'cpp')
  const chunks = chunkText(src, lang, { maxLines: 80 })
  const symbols = chunks.map((chunk) => chunk.symbol)
  assert.ok(symbols.includes('extern int api_init(void);'), `got ${symbols}`)
  assert.ok(symbols.includes('extern int api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern int matrix[2][3];'), `got ${symbols}`)
  assert.ok(symbols.includes('extern int (*matrix_ptr)[3];'), `got ${symbols}`)
  assert.ok(symbols.includes('extern int(*tight_matrix_ptr)[3];'), `got ${symbols}`)
  assert.ok(symbols.includes('extern int first, second;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern void (*callback)(int);'), `got ${symbols}`)
  assert.ok(symbols.includes('extern "C" char *(*c_callback)(int);'), `got ${symbols}`)
  assert.ok(symbols.includes('extern "C" char const *(*get_name)(void);'), `got ${symbols}`)
  assert.ok(symbols.includes('extern "C" int initialized_export = 1;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern "C" int * const api_handle;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern "C" int * const *api_handle_chain;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern "C" int *const *tight_api_handle;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern "C" void (* const direct_callback)(int);'), `got ${symbols}`)
  assert.ok(symbols.includes('extern "C" void (*const direct_tight_callback)(int);'), `got ${symbols}`)
  assert.ok(symbols.includes('extern char *api_name(void);'), `got ${symbols}`)
  assert.ok(symbols.includes('extern "C" void api_shutdown(void);'), `got ${symbols}`)
  assert.ok(symbols.includes('int pending_c_api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern int namespace_api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern int split_namespace_api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern int attributed_namespace_api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern int nested_namespace_api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('int namespace_c_api_version;'), `got ${symbols}`)
})

test('chunkText: C-linkage declarations accept adjacent strings and pointer arrays', () => {
  const src = [
    'extern"C" int adjacent_api_version;',
    'extern"C" void (*adjacent_callbacks[4])(int);',
    'extern"C"{',
    'int linkage_api_version;',
    'void (*linkage_callbacks[4])(int);',
    '}',
    'extern"C"',
    '{',
    'int split_adjacent_linkage_version;',
    '}',
    'extern',
    '"C" {',
    'int split_keyword_linkage_version;',
    '}',
    'extern',
    '"C" int split_keyword_api_version;',
  ].join('\n')
  const symbols = chunkText(src, languageForPath('foo.h'), { maxLines: 80 }).map((chunk) => chunk.symbol)
  assert.ok(symbols.includes('extern"C" int adjacent_api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern"C" void (*adjacent_callbacks[4])(int);'), `got ${symbols}`)
  assert.ok(symbols.includes('int linkage_api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('void (*linkage_callbacks[4])(int);'), `got ${symbols}`)
  assert.ok(symbols.includes('int split_adjacent_linkage_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('int split_keyword_linkage_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('extern "C" int split_keyword_api_version;'), `got ${symbols}`)
})

test('chunkText: C linkage block recognises pointer-return prototypes', () => {
  const src = [
    '#pragma once',
    'extern "C" {',
    'const char *api_name(void);',
    'char const *qualified_api_name(void);',
    'int *const *api_handle_chain(void);',
    'void install(void (*cb)(int));',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'const char *api_name(void);'), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'char const *qualified_api_name(void);'), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'int *const *api_handle_chain(void);'), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'void install(void (*cb)(int));'), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: direct C linkage declarations accept inline functions', () => {
  const chunks = chunkText('extern "C" inline int api(void);', languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'extern "C" inline int api(void);'), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: multiline C-linkage declarations retain symbol boundaries', () => {
  const src = [
    'extern "C" const char *',
    'extern_api_name(void);',
    'extern "C" { const char *',
    'inline_api_name(void);',
    '}',
    'extern "C" {',
    'const char *',
    'split_api_name(void);',
    '}',
    'extern "C"',
    'void (*split_callback)',
    '(int);',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'extern "C" const char * extern_api_name(void);'), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'const char * inline_api_name(void);'), `got ${chunks.map((chunk) => chunk.symbol)}`)
  const declaration = chunks.find((chunk) => chunk.symbol === 'const char * split_api_name(void);')
  assert.ok(declaration, `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.equal(declaration.startLine, 7)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'void (*split_callback) (int);'), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: split extern C pointer-return declarations preserve the extern prefix', () => {
  const src = ['extern', '"C" const char *', 'api_name(void);'].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(
    chunks.some((chunk) => chunk.symbol === 'extern "C" const char * api_name(void);' && chunk.startLine === 1),
    `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`,
  )
})

test('chunkText: nested C linkage blocks recognise declarations', () => {
  const src = [
    'extern "C" {',
    'extern "C" {',
    'int nested_linkage_version;',
    'void run() {',
    'int local_value;',
    '}',
    '}',
    '}',
    'extern "C" { extern "C" {',
    'int same_line_nested_linkage_version;',
    '} }',
    'extern "C" { extern "C" { int inline_nested_linkage_version; } }',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  const symbols = chunks.map((chunk) => chunk.symbol)
  assert.ok(symbols.includes('int nested_linkage_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('int same_line_nested_linkage_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('int inline_nested_linkage_version;'), `got ${symbols}`)
  assert.equal(symbols.includes('int local_value;'), false)
})

test('chunkText: C linkage block recognises multiword return types', () => {
  const src = [
    'extern "C" {',
    'unsigned long api_version(void);',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'unsigned long api_version(void);'), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C linkage block recognises variable declarations', () => {
  const src = [
    'int ordinary_variable;',
    'extern "C" {',
    'int same_line_api_version;',
    '#define DECLARE() ' + '\\',
    '  extern int macro_only; ' + '\\',
    '  {',
    'int after_macro;',
    'const char *spliced_string = "brace ' + '\\',
    '  { not a scope";',
    'int after_spliced_string;',
    'const char *pair_spliced_string = "brace ' + '\\\\',
    '  n { not a scope";',
    'int after_pair_spliced_string;',
    '}',
    'extern "C"',
    '{',
    '// } inside a comment does not close the linkage block',
    'int api_version;',
    '// continued linkage comment ' + '\\',
    '}',
    'int after_spliced_comment;',
    'int matrix[2][3];',
    'int (*block_matrix)[3];',
    'int(*tight_block_matrix)[3];',
    'int first, second;',
    'char *(*block_name)(int);',
    'int * const block_handle;',
    'int * const *block_handle_chain;',
    'int *const *tight_block_handle;',
    'void (* const block_callback_const)(int);',
    'void (*const block_tight_callback)(int);',
    'int initialized_version = 1;',
    'int const initialized_const_version = 1;',
    'int const volatile api_flags;',
    'const char *version_string = "version;";',
    'const char *raw_string = u8R"tag(" { brace )tag";',
    'const char *spliced_raw_string = R"tag(payload )ta' + '\\',
    'g" } not scope )tag";',
    'int after_spliced_raw_string;',
    'int commented_version; // version',
    'void api_run() {',
    'int local_value;',
    'extern int linkage_local_extern;',
    '}',
    '}',
    'extern "C" /* multiline linkage comment',
    '   continues */ {',
    'int multiline_documented_api_version;',
    'void (*block_callback)(int);',
    'int const block_const_version = 1;',
    '}',
    'extern "C" /* same-line linkage comment */ {',
    'int documented_api_version;',
    '}',
    'extern "C" /* split linkage comment */',
    '{',
    'int split_documented_api_version;',
    '}',
    'int another_ordinary_variable;',
    'extern "C" { int inline_version; }',
    'void helper() {',
    'extern int block_scope_extern;',
    'extern struct Foo block_scope_struct;',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  const symbols = chunks.map((chunk) => chunk.symbol)
  assert.ok(symbols.includes('int api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('int same_line_api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('int after_macro;'), `got ${symbols}`)
  assert.ok(symbols.includes('int after_spliced_string;'), `got ${symbols}`)
  assert.ok(symbols.includes('int after_pair_spliced_string;'), `got ${symbols}`)
  assert.ok(symbols.includes('int after_spliced_comment;'), `got ${symbols}`)
  assert.ok(symbols.includes('int matrix[2][3];'), `got ${symbols}`)
  assert.ok(symbols.includes('int (*block_matrix)[3];'), `got ${symbols}`)
  assert.ok(symbols.includes('int(*tight_block_matrix)[3];'), `got ${symbols}`)
  assert.ok(symbols.includes('int first, second;'), `got ${symbols}`)
  assert.ok(symbols.includes('char *(*block_name)(int);'), `got ${symbols}`)
  assert.ok(symbols.includes('int * const block_handle;'), `got ${symbols}`)
  assert.ok(symbols.includes('int * const *block_handle_chain;'), `got ${symbols}`)
  assert.ok(symbols.includes('int *const *tight_block_handle;'), `got ${symbols}`)
  assert.ok(symbols.includes('void (* const block_callback_const)(int);'), `got ${symbols}`)
  assert.ok(symbols.includes('void (*const block_tight_callback)(int);'), `got ${symbols}`)
  assert.ok(symbols.includes('int initialized_version = 1;'), `got ${symbols}`)
  assert.ok(symbols.includes('int const initialized_const_version = 1;'), `got ${symbols}`)
  assert.ok(symbols.includes('int const volatile api_flags;'), `got ${symbols}`)
  assert.ok(symbols.includes('const char *version_string = "version;";'), `got ${symbols}`)
  assert.ok(symbols.includes('int after_spliced_raw_string;'), `got ${symbols}`)
  assert.ok(symbols.includes('int commented_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('int inline_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('void api_run() {'), `got ${symbols}`)
  assert.ok(symbols.includes('int multiline_documented_api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('void (*block_callback)(int);'), `got ${symbols}`)
  assert.ok(symbols.includes('int const block_const_version = 1;'), `got ${symbols}`)
  assert.ok(symbols.includes('int documented_api_version;'), `got ${symbols}`)
  assert.ok(symbols.includes('int split_documented_api_version;'), `got ${symbols}`)
  assert.equal(symbols.includes('int ordinary_variable;'), false)
  assert.equal(symbols.includes('int local_value;'), false)
  assert.equal(symbols.includes('extern int linkage_local_extern;'), false)
  assert.equal(symbols.includes('extern int block_scope_extern;'), false)
  assert.equal(symbols.includes('extern int macro_only;'), false)
  assert.equal(symbols.includes('extern struct Foo block_scope_struct;'), false)
  assert.equal(symbols.includes('int another_ordinary_variable;'), false)
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

test('chunkText: C linkage block accepts a backslash-spliced opener', () => {
  const src = [
    'extern "C" ' + '\\',
    '{',
    'int spliced_linkage_api_version;',
    '}',
  ].join('\n')
  const symbols = chunkText(src, languageForPath('foo.h'), { maxLines: 80 }).map((chunk) => chunk.symbol)
  assert.ok(symbols.includes('int spliced_linkage_api_version;'), 'got ' + symbols)
})

test('chunkText: C linkage block recognises braced variable initialization', () => {
  const src = ['extern "C" {', 'int api_version{1};', '}'].join('\n')
  const symbols = chunkText(src, languageForPath('foo.h'), { maxLines: 80 }).map((chunk) => chunk.symbol)
  assert.ok(symbols.includes('int api_version{1};'), 'got ' + symbols)
})

test('chunkText: C++ header recognises qualified method declarations', () => {
  const src = [
    'class Foo {',
    'public:',
    '  void run() const;',
    '  void update() volatile && noexcept;',
    '  virtual void draw() const override;',
    '  static int count();',
    '  int value() const noexcept;',
    '  virtual int pureValue() const noexcept = 0;',
    '  std::vector<int> items() const;',
    '};',
  ].join('\n')
  const symbols = chunkText(src, languageForPath('foo.h'), { maxLines: 80 }).map((chunk) => chunk.symbol)
  assert.ok(symbols.includes('void run() const;'), 'got ' + symbols)
  assert.ok(symbols.includes('void update() volatile && noexcept;'), 'got ' + symbols)
  assert.ok(symbols.includes('virtual void draw() const override;'), 'got ' + symbols)
  assert.ok(symbols.includes('static int count();'), 'got ' + symbols)
  assert.ok(symbols.includes('int value() const noexcept;'), 'got ' + symbols)
  assert.ok(symbols.includes('virtual int pureValue() const noexcept = 0;'), 'got ' + symbols)
  assert.ok(symbols.includes('std::vector<int> items() const;'), 'got ' + symbols)
})

test('chunkText: C++ header recognises qualified out-of-class method definitions', () => {
  const src = [
    'class Foo {',
    'public:',
    '  void run();',
    '};',
    'inline void Foo::run() {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'inline void Foo::run() {}' && chunk.startLine === 5), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ header recognises operator overload declarations', () => {
  const src = [
    'class Foo {',
    'public:',
    '  bool operator==(const Foo& other) const;',
    '  int operator[](std::size_t index) const;',
    '  void operator()(int value);',
    '};',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'bool operator==(const Foo& other) const;' && chunk.startLine === 3), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'int operator[](std::size_t index) const;'), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'void operator()(int value);'), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ header recognises trailing-return and deleted methods', () => {
  const src = [
    'class Foo {',
    'public:',
    '  auto size() const -> std::size_t;',
    '  void reset() = delete;',
    '};',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'auto size() const -> std::size_t;'), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'void reset() = delete;'), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ split class methods are not misclassified as constructors', () => {
  const src = [
    'class Foo {',
    'public:',
    '  void',
    '  run();',
    '  Foo();',
    '};',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'void run();' && chunk.startLine === 3), `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'Foo();' && chunk.startLine === 5), `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`)
  assert.equal(chunks.some((chunk) => chunk.symbol === 'run();'), false)
})

test('chunkText: C++ class recognises constructors and destructors without matching body calls', () => {
  const src = [
    'class Foo {',
    'public:',
    '  Foo();',
    '  ~Foo();',
    '  void exercise() {',
    '    Foo();',
    '  }',
    '};',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'Foo();' && chunk.startLine === 3), 'got ' + chunks.map((chunk) => chunk.symbol))
  assert.ok(chunks.some((chunk) => chunk.symbol === '~Foo();' && chunk.startLine === 4), 'got ' + chunks.map((chunk) => chunk.symbol))
  assert.equal(chunks.some((chunk) => chunk.symbol === 'Foo();' && chunk.startLine === 6), false)
})

test('chunkText: C++ recognises constructor initializer lists inside classes', () => {
  const src = [
    'class Foo {',
    '  int member;',
    'public:',
    '  Foo() : member{0} {}',
    '};',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'Foo() : member{0} {}' && chunk.startLine === 4), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ recognises split in-class constructor definitions', () => {
  const src = [
    'class Foo {',
    '  int member;',
    'public:',
    '  Foo()',
    '    : member{0}',
    '  {',
    '  }',
    '};',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'Foo()' && chunk.startLine === 4), `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`)
})

test('chunkText: C++ recognizes in-class constructor templates', () => {
  const src = [
    'class Foo {',
    'public:',
    '  template<class U>',
    '  Foo(U value);',
    '};',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(
    chunks.some((chunk) => chunk.symbol === 'template<class U> Foo(U value);' && chunk.startLine === 3),
    `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`,
  )
})

test('chunkText: C++ recognises in-class constructor function-try-blocks', () => {
  const src = [
    'class Foo {',
    '  int member;',
    'public:',
    '  Foo() noexcept try : member{0} {}',
    '  catch (...) {}',
    '};',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(
    chunks.some((chunk) => chunk.symbol === 'Foo() noexcept try : member{0} {}' && chunk.startLine === 4),
    `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`,
  )
})

test('chunkText: C++ recognises out-of-class constructor and destructor definitions', () => {
  const src = [
    'class Foo {',
    'public:',
    '  Foo();',
    '  ~Foo();',
    '};',
    'Foo::Foo() {}',
    'Foo::~Foo() = default;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.cpp'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'Foo::Foo() {}' && chunk.startLine === 6), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'Foo::~Foo() = default;' && chunk.startLine === 7), `got ${chunks.map((chunk) => chunk.symbol)}`)

  const templated = [
    'template<class T> struct Outer {',
    '  struct Inner { Inner(); };',
    '};',
    'template<class T>',
    'Outer<T>::Inner::Inner() {}',
  ].join('\n')
  const templatedChunks = chunkText(templated, languageForPath('foo.cpp'), { maxLines: 80 })
  assert.ok(
    templatedChunks.some((chunk) => chunk.symbol === 'template<class T> Outer<T>::Inner::Inner() {}' && chunk.startLine === 4),
    `got ${templatedChunks.map((chunk) => chunk.symbol)}`,
  )
})

test('chunkText: C++ recognizes constrained constructors and prospective destructors', () => {
  const src = [
    'template<class T>',
    'struct Foo {',
    'public:',
    '  Foo() requires true {}',
    '  ~Foo() requires true {}',
    '};',
    'template<class T>',
    'Foo<T>::Foo() requires true {}',
    'template<class T>',
    'Foo<T>::~Foo() requires true {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.cpp'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'Foo() requires true {}' && chunk.startLine === 4), `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === '~Foo() requires true {}' && chunk.startLine === 5), `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'template<class T> Foo<T>::Foo() requires true {}' && chunk.startLine === 7), `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'template<class T> Foo<T>::~Foo() requires true {}' && chunk.startLine === 9), `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`)
})

test('chunkText: C++ recognises globally qualified out-of-class constructors', () => {
  const src = ['class Foo { public: Foo(); };', '::Foo::Foo() {}'].join('\n')
  const chunks = chunkText(src, languageForPath('foo.cpp'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === '::Foo::Foo() {}' && chunk.startLine === 2), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ recognises multiline constructor function-try-block headers', () => {
  const src = [
    'struct Foo {',
    '  int member;',
    '  Foo();',
    '};',
    'Foo::Foo() try',
    '  : member{0}',
    '{',
    '}',
    'catch (...) {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.cpp'), { maxLines: 80 })
  assert.ok(
    chunks.some((chunk) => chunk.startLine === 5 && chunk.symbol.startsWith('Foo::Foo() try')),
    `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`,
  )
})

test('chunkText: C++ preserves stacked template headers for nested constructors', () => {
  const src = [
    'template<class T>',
    'class Outer {',
    '  template<class U>',
    '  struct Inner { Inner(); };',
    '};',
    'template<class T>',
    'template<class U>',
    'Outer<T>::Inner<U>::Inner() {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.cpp'), { maxLines: 80 })
  assert.ok(
    chunks.some((chunk) => chunk.startLine === 6 && chunk.symbol === 'template<class T> template<class U> Outer<T>::Inner<U>::Inner() {}'),
    `got ${chunks.map((chunk) => `${chunk.startLine}:${chunk.symbol}`)}`,
  )
})

test('chunkText: C++ recognises out-of-class constructor function-try-blocks', () => {
  const src = [
    'struct Foo {',
    '  int member;',
    '  Foo();',
    '};',
    'Foo::Foo() try {}',
    'catch (...) {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.cpp'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'Foo::Foo() try {}' && chunk.startLine === 5), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ namespace function calls are not constructor boundaries', () => {
  const src = [
    'namespace N {',
    '  void N();',
    '}',
    'void use() {',
    '  N::N();',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.cpp'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'void use() {' && chunk.startLine === 4), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.equal(chunks.some((chunk) => chunk.symbol === 'N::N();'), false)
})

test('chunkText: C++ class recognises constructors when the opening brace is on the next line', () => {
  const src = ['class Foo', '{', 'public:', '  Foo();', '};'].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'Foo();' && chunk.startLine === 4), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ union recognises constructors with either brace layout', () => {
  const cases = [
    { src: ['union U {', '  U();', '};'].join('\n'), constructorLine: 2 },
    { src: ['union U', '{', '  U();', '};'].join('\n'), constructorLine: 3 },
  ]
  for (const { src, constructorLine } of cases) {
    const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
    assert.ok(chunks.some((chunk) => chunk.symbol === 'U();' && chunk.startLine === constructorLine), `got ${chunks.map((chunk) => chunk.symbol)}`)
  }
})

test('chunkText: same-line template class recognises its constructor', () => {
  const src = ['template <typename T> class Foo {', 'public:', '  Foo();', '};'].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol.startsWith('template <typename T> class Foo')), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.ok(chunks.some((chunk) => chunk.symbol === 'Foo();' && chunk.startLine === 3), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ same-line function templates are symbols', () => {
  const declaration = 'template <typename T> T convert(T value);'
  const chunks = chunkText(declaration, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === declaration), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ multiline function templates start at the template header', () => {
  const src = ['void before();', 'template <typename T>', 'T convert(T value);'].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'template <typename T> T convert(T value);' && chunk.startLine === 2), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ class members inside C linkage are not C global variables', () => {
  const src = [
    'extern "C" {',
    'struct CApi {',
    '  int value;',
    '  void run();',
    '};',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'struct CApi {'), 'got ' + chunks.map((chunk) => chunk.symbol))
  assert.equal(chunks.some((chunk) => chunk.symbol === 'int value;'), false)
})

test('chunkText: split namespace headers retain extern declarations', () => {
  const src = ['void before();', 'namespace', 'api', '{', 'extern int api_version;', '}'].join('\n')
  const chunks = chunkText(src, languageForPath('foo.h'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'extern int api_version;' && chunk.startLine === 5), `got ${chunks.map((chunk) => chunk.symbol)}`)
})

test('chunkText: C++ header does not treat body statements as symbols', () => {
  const src = [
    'inline int calculate(bool ready) {',
    '  if (!ready) {',
    '    throw makeError();',
    '  }',
    '  return helper();',
    '}',
  ].join('\n')
  const symbols = chunkText(src, languageForPath('foo.h'), { maxLines: 80 }).map((chunk) => chunk.symbol)
  assert.ok(symbols.includes('inline int calculate(bool ready) {'), 'got ' + symbols)
  assert.equal(symbols.includes('throw makeError();'), false)
  assert.equal(symbols.includes('return helper();'), false)
})

test('chunkText: expression bodies stay scoped while opening delimiters span lines', () => {
  const cases = [
    ['a.js', ['const f = () => (', '1', ')', 'const unrelated = 1'], 'const f = () => ('],
    ['a.kt', ['fun f() = (', '1', ')', 'val unrelated = 2'], 'fun f() = ('],
    ['a.scala', ['def f = (', '1', ')', 'val unrelated = 3'], 'def f = ('],
  ] as const

  for (const [path, lines, declaration] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    const body = chunks.find((chunk) => chunk.content.includes(lines[1]))
    const unrelated = chunks.find((chunk) => chunk.content === lines[3])
    assert.equal(body?.symbol, declaration, path)
    assert.equal(unrelated?.symbol, '', path)
  }
})

test('chunkText: expression bodies ignore statement-like comment and template text', () => {
  const cases = [
    ['a.js', ['const f = () =>', '/* note', 'const unrelated = 1', '*/', '  1', 'const after = 2']],
    ['b.js', ['const f = () => `', 'const unrelated = 1', '`', 'const after = 2']],
  ] as const

  for (const [path, lines] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    const body = chunks.find((chunk) => chunk.content.includes(lines.at(-2)!))
    assert.equal(body?.symbol, lines[0], path)
    const after = chunks.find((chunk) => chunk.content === lines.at(-1))
    assert.equal(after?.symbol, '', path)
  }
})

test('chunkText: triple-quoted strings do not end Python or Kotlin function scopes', () => {
  const cases = [
    ['a.py', ['def f():', '    text = """', 'class NotAClass:', '"""', '    return 1', 'unrelated = 2'], '    return 1', 'unrelated = 2'],
    ['a.kt', ['fun f() {', '  val text = """first', '    \\" } still raw text', '    second"""', '  return text', '}', 'val unrelated = 3'], '  return text', 'val unrelated = 3'],
  ] as const

  for (const [path, lines, bodyText, unrelatedText] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    const body = chunks.find((chunk) => chunk.content.includes(bodyText))
    const unrelated = chunks.find((chunk) => chunk.content === unrelatedText)
    assert.equal(body?.symbol, lines[0], path)
    assert.equal(unrelated?.symbol, '', path)
  }
})

test('chunkText: annotation-like text at the end of a Kotlin raw string stays literal', () => {
  const src = [
    'val text = """first line',
    '  @Deprecated"""',
    'fun replacement() = "done"',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const literal = chunks.find((chunk) => chunk.content.includes('@Deprecated"""'))
  const declaration = chunks.find((chunk) => chunk.content.includes('fun replacement()'))
  assert.equal(literal?.symbol, '')
  assert.equal(declaration?.symbol, 'fun replacement() = "done"')
})

test('chunkText: Go raw backticks do not leave template interpolation active', () => {
  const src = [
    'func f() {',
    '  raw := `${`',
    '  return raw',
    '}',
    'var unrelated = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.go'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return raw'))
  const unrelated = chunks.find((chunk) => chunk.content === 'var unrelated = 1')
  assert.equal(body?.symbol, 'func f() {')
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: Ruby assignment conditionals keep the method scope open', () => {
  const src = [
    'def f',
    '  value = if condition',
    '    1',
    '  else',
    '    2',
    '  end',
    '  value',
    'end',
    'unrelated = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('  value\nend'))
  const unrelated = chunks.find((chunk) => chunk.content === 'unrelated = 1')
  assert.equal(body?.symbol, 'def f')
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: Ruby percent literals do not close the method scope', () => {
  const src = [
    'def f',
    '  text = %q{end}',
    '  value = 1',
    'end',
    'unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('value = 1'))
  const unrelated = chunks.find((chunk) => chunk.content === 'unrelated = 2')
  assert.equal(body?.symbol, 'def f')
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: C++ preprocessor continuation braces do not leak class symbols', () => {
  const src = [
    'class Foo {',
    '#define OPEN \\',
    '  {',
    'public:',
    '  void run();',
    '};',
    'int unrelated;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.h'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('void run();'))
  const unrelated = chunks.find((chunk) => chunk.content === 'int unrelated;')
  assert.equal(method?.symbol, 'void run();')
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: expression bodies end before top-level call statements', () => {
  const src = ['const f = () =>', '  1', 'console.log("after")'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('  1'))
  const after = chunks.find((chunk) => chunk.content === 'console.log("after")')
  assert.equal(body?.symbol, 'const f = () =>')
  assert.equal(after?.symbol, '')
})

test('chunkText: Swift bodyless async declarations end at the protocol boundary', () => {
  const src = [
    'protocol API {',
    '  func fetch() async throws -> String',
    '}',
    'print("after")',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const requirement = chunks.find((chunk) => chunk.content.includes('func fetch()'))
  const after = chunks.find((chunk) => chunk.content === 'print("after")')
  assert.equal(requirement?.symbol, 'func fetch() async throws -> String')
  assert.equal(after?.symbol, '')
})

test('chunkText: Ruby default arguments do not close the enclosing class scope', () => {
  const src = [
    'class Thing',
    '  def first(value = 1)',
    '    value',
    '  end',
    '  attr_reader :value',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const member = chunks.find((chunk) => chunk.content.includes('attr_reader'))
  const outside = chunks.find((chunk) => chunk.content === 'outside = 1')
  assert.equal(member?.symbol, 'class Thing')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby loop do separators count as one block opener', () => {
  const src = [
    'def f',
    '  while ready do',
    '    work',
    '  end',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content === 'outside = 1')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby for-loop targets are known locals for shift detection', () => {
  const src = [
    'def f',
    '  for value in values',
    '    value <<item',
    '  end',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const shift = chunks.find((chunk) => chunk.content.includes('value <<item'))
  const outside = chunks.find((chunk) => chunk.content === 'outside = 1')
  assert.equal(shift?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby multiline strings do not close the enclosing method', () => {
  const src = [
    'def f',
    '  text = "',
    'end',
    '"',
    '  value = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('value = 1'))
  const outside = chunks.find((chunk) => chunk.content === 'outside = 1')
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Bash glob paths do not start block comments', () => {
  const src = [
    'function f() {',
    '  echo /*',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content === 'outside=1')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Rust raw strings do not close enclosing function scopes', () => {
  const src = [
    'fn f() {',
    '  let text = r#"quote " } still literal"#;',
    '  return text;',
    '}',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rs'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return text;'))
  const outside = chunks.find((chunk) => chunk.content === 'outside();')
  assert.equal(body?.symbol, 'fn f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Kotlin parameter defaults do not end function declarations', () => {
  const src = [
    'fun f(value: Int = 1)',
    '{',
    '  return value',
    '}',
    'val unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value'))
  assert.equal(body?.symbol, 'fun f(value: Int = 1)')
})

test('chunkText: top-level JavaScript constructor expressions end expression bodies', () => {
  const src = ['const f = () =>', '  1', 'new Worker()'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content === 'new Worker()')
  assert.equal(after?.symbol, '')
})

test('chunkText: Ruby setter names are not endless-method assignments', () => {
  const src = [
    'class Thing',
    '  def value=(x)',
    '    @value = x',
    '  end',
    '  attr_reader :value',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const member = chunks.find((chunk) => chunk.content.includes('attr_reader'))
  assert.equal(member?.symbol, 'class Thing')
})

test('chunkText: C++ directives remain masked when preceded by block comments', () => {
  const src = [
    'class Foo {',
    '/* note */ #define OPEN \\',
    '  {',
    'public:',
    '  void run();',
    '};',
    'int unrelated;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.h'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('void run();'))
  const unrelated = chunks.find((chunk) => chunk.content === 'int unrelated;')
  assert.equal(method?.symbol, 'void run();')
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: Rust raw byte strings do not close enclosing function scopes', () => {
  const src = [
    'fn f() {',
    '  let text = br#"quote " } still literal"#;',
    '  return text;',
    '}',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rs'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return text;'))
  assert.equal(body?.symbol, 'fn f() {')
})

test('chunkText: JavaScript assignment statements end expression bodies', () => {
  const src = ['const f = () =>', '  1', 'value = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content === 'value = 2')
  assert.equal(after?.symbol, '')
})

test('chunkText: Ruby begin expressions keep the enclosing method scope open', () => {
  const src = [
    'def f',
    '  value = begin',
    '    1',
    '  rescue',
    '    2',
    '  end',
    '  value',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('  value\nend'))
  assert.equal(body?.symbol, 'def f')
})

test('chunkText: quoted Ruby heredoc delimiters protect the heredoc body', () => {
  const src = [
    'def f',
    "  text = <<~'TEXT'",
    '    end',
    '  TEXT',
    '  value = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('value = 1'))
  assert.equal(body?.symbol, 'def f')
})

test('chunkText: command-call Ruby heredoc bodies do not leave stale method labels', () => {
  const src = [
    'def f',
    '  writer.write <<~TEXT',
    '    def fake',
    '  TEXT',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('def fake'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Python parameter annotations do not mark a function as an inline suite', () => {
  const src = ['def f(value: int):', '    return value', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value'))
  assert.equal(body?.symbol, 'def f(value: int):')
})

test('chunkText: Ruby default parameters keep the method body labeled', () => {
  const src = ['def f(value = 1)', '  value', 'end', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('  value'))
  assert.equal(body?.symbol, 'def f(value = 1)')
})

test('chunkText: Ruby setter methods keep their body labeled', () => {
  const src = ['def value=(input)', '  @value = input', 'end', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('@value'))
  assert.equal(body?.symbol, 'def value=(input)')
})

test('chunkText: an unindented call can start a JavaScript arrow body', () => {
  const src = ['const f = () =>', 'foo()'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('foo()'))
  assert.equal(body?.symbol, 'const f = () =>')
})

test('chunkText: JavaScript logical assignment ends expression bodies', () => {
  const src = ['const f = () =>', '  1', 'value ||= 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content === 'value ||= 2')
  assert.equal(after?.symbol, '')
})

test('chunkText: JavaScript await and arrow operands can start regex literals', () => {
  const src = [
    'async function f() {',
    '  const matcher = value => /}/.test(value)',
    "  await /}/.test('}')",
    '  return true',
    '}',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return true'))
  assert.equal(body?.symbol, 'async function f() {')
})

test('chunkText: Ruby regexes after division do not close the method scope', () => {
  const src = [
    'def f',
    '  value = 1 / /end/',
    '  value',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('  value\nend'))
  assert.equal(body?.symbol, 'def f')
})

test('chunkText: empty Ruby regex literals do not keep method symbols active', () => {
  const src = [
    'def f',
    '  pattern = //',
    '  after = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby declarations inside multiline literals are not symbols', () => {
  const src = [
    'def f',
    '  quoted = "',
    'def fake_quoted',
    '"',
    '  percent = %q{',
    'def fake_percent',
    '}',
    '  pattern = /',
    'def fake_regex',
    '/',
    '  value = 1',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('value = 1'))
  assert.equal(body?.symbol, 'def f')
})

test('chunkText: Rust declarations inside raw strings are not symbols', () => {
  const src = [
    'fn f() {',
    '  let text = r#"',
    'fn fake() {',
    '"#;',
    '  return text;',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rs'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return text;'))
  assert.equal(body?.symbol, 'fn f() {')
})

test('chunkText: Kotlin bodyless declarations with parameter defaults end at interface scope', () => {
  const src = [
    'interface API {',
    '  fun fetch(limit: Int = 1)',
    '}',
    'println("after")',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('println("after")'))
  assert.equal(after?.symbol, '')
})

test('chunkText: Ruby endless operator methods do not retain the class symbol', () => {
  const src = ['class Number', '  def +(other) = other', 'end', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('def +(other)'))
  const outside = chunks.find((chunk) => chunk.content === 'outside = 1')
  assert.equal(method?.symbol, 'def +(other) = other')
  assert.equal(outside?.symbol, '')
})

test('chunkText: inline Ruby endless methods do not keep class scope open', () => {
  const src = ['class Foo; def bar = 1', 'end', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('def bar'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(method?.symbol, 'class Foo; def bar = 1')
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript instanceof allows a regex literal operand', () => {
  const src = [
    'function f(value) {',
    '  if (value instanceof /}/) {',
    '    return true',
    '  }',
    '}',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return true'))
  assert.equal(body?.symbol, 'function f(value) {')
})

test('chunkText: postfix increment keeps the following division distinct from regex', () => {
  const src = [
    'function f(i) {',
    '  i++ / /}/',
    '  return true',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return true'))
  assert.equal(body?.symbol, 'function f(i) {')
})

test('chunkText: semicolon-terminated sibling expressions end JavaScript arrow bodies', () => {
  const src = ['const f = () =>', '  1', 'foo;'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('foo;'))
  assert.equal(after?.symbol, '')
})

test('chunkText: Rust lifetimes do not leave quote state open', () => {
  const src = [
    "fn f<'a>(x: &'a str) -> &'a str {",
    '  x',
    '}',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rs'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside();'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: Unicode Rust lifetimes do not leave quote state open', () => {
  const src = [
    "fn f<'α>(x: &'α str) -> &'α str {",
    '  x',
    '}',
    'fn outside() {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rs'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('fn outside()'))
  assert.equal(outside?.symbol, 'fn outside() {}')
})

test('chunkText: C++ digit separators do not leave quote state open', () => {
  const src = [
    'void f() {',
    "  auto n=1'000; auto s=R\"(x)\"; } char c='x';",
    'consume();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.cpp'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('auto n=1'))
  const outside = chunks.find((chunk) => chunk.content.includes('consume();'))
  assert.equal(body?.symbol, 'void f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby shift operators are not heredoc openers', () => {
  const src = [
    'def f',
    '  value = 1',
    '  value << item',
    '  value',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby assigned locals with spaced shifts are not heredoc openers', () => {
  const src = [
    'def f',
    '  value = 1',
    '  value <<item',
    '  after_shift = value',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby local assignments do not leak between methods', () => {
  const src = [
    'def first',
    '  value = 1',
    'end',
    'def second',
    '  value <<TEXT',
    '    end',
    'TEXT',
    '  after = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def second')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby heredocs after assignment operators remain heredocs', () => {
  const src = [
    'def f',
    '  text = "prefix" + <<~TEXT',
    '    end',
    '  TEXT',
    '  after = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby method and block parameters are local for shift detection', () => {
  const cases = [
    ['def f(value)', '  value <<item', 'end', 'item', 'outside = 1'],
    ['def f', '  [1].each do |value|', '    value <<item', '  end', 'item', 'end', 'outside = 1'],
  ] as const

  for (const lines of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath('a.rb'), { maxLines: 80 })
    const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
    assert.ok(outside)
    assert.equal(outside!.symbol, '')
  }
})

test('chunkText: multiline Ruby method parameters are local for shift detection', () => {
  const src = [
    'def f(',
    '  value',
    ')',
    '  value <<item',
    '  after_shift = value',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after_shift = value'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f(')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby case expressions assigned to locals keep the method scope open', () => {
  const src = [
    'def f',
    '  value = case kind',
    '  when :first',
    '    1',
    '  else',
    '    2',
    '  end',
    '  after_case = value',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after_case'))
  assert.equal(body?.symbol, 'def f')
})

test('chunkText: TypeScript union aliases retain their symbol across pipe continuations', () => {
  const src = ['type Result = Success |', '  Failure', 'const next = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('Failure'))
  assert.equal(continuation?.symbol, 'type Result = Success |')
})

test('chunkText: JavaScript arrow expression bodies retain symbols across dot continuations', () => {
  const src = ['const f = () => foo()', '  .bar()', 'const next = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('.bar()'))
  assert.equal(continuation?.symbol, 'const f = () => foo()')
})

test('chunkText: Kotlin expression bodies retain symbols through lambda call chains', () => {
  const src = [
    'fun f() = run {',
    '  1',
    '}',
    '  .also { value -> value }',
    'val unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('.also'))
  assert.equal(continuation?.symbol, 'fun f() = run {')
})

test('chunkText: bare JavaScript expressions end prior arrow-body symbols', () => {
  const src = ['const f = () => 1', 'value', 'const unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('value'))
  assert.equal(after?.symbol, '')
})

test('chunkText: JavaScript unary expression statements end prior arrow-body symbols', () => {
  for (const statement of ['!ready', '~value', '++counter']) {
    const src = ['const f = () => 1', statement, 'const unrelated = 2'].join('\n')
    const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
    const chunk = chunks.find((candidate) => candidate.content.includes(statement))
    assert.equal(chunk?.symbol, '', statement)
  }

  const continued = ['const f = () => ready &&', '  !other', 'const unrelated = 2'].join('\n')
  const chunks = chunkText(continued, languageForPath('a.js'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('!other'))
  assert.equal(continuation?.symbol, 'const f = () => ready &&')
})

test('chunkText: JavaScript string literal expressions end prior arrow-body symbols', () => {
  const src = ['const f = () => foo()', '  .bar()', "'standalone'"].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const literal = chunks.find((chunk) => chunk.content.includes('standalone'))
  assert.equal(literal?.symbol, '')
})

test('chunkText: Scala default parameters do not end a method before its body', () => {
  const src = [
    'def f(value: Int = 1): Int =',
    '  value',
    'val unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('  value'))
  assert.equal(body?.symbol, 'def f(value: Int = 1): Int =')
})

test('chunkText: Kotlin block bodies can start on the line after the signature', () => {
  const src = [
    'fun f()',
    '{',
    '  return 1',
    '}',
    'val unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1'))
  assert.equal(body?.symbol, 'fun f()')
})

test('chunkText: Swift block bodies can start on the line after the signature', () => {
  const src = [
    'func f()',
    '{',
    '  return 1',
    '}',
    'let unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1'))
  assert.equal(body?.symbol, 'func f()')
})

test('chunkText: JavaScript default object parameters do not count as function bodies', () => {
  const src = [
    'function f(options = {})',
    '{',
    '  return options',
    '}',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return options'))
  assert.equal(body?.symbol, 'function f(options = {})')
})

test('chunkText: TypeScript object return types do not count as function bodies', () => {
  const src = [
    'function f(): { value: string }',
    '{',
    '  return getValue()',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return getValue()'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(body?.symbol, 'function f(): { value: string }')
  assert.equal(outside?.symbol, '')
})

test('chunkText: multiline default object parameters do not count as function bodies', () => {
  const src = [
    'function f(',
    '  options = {',
    '    value: 1,',
    '  },',
    ') {',
    '  return options',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return options'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.ok(body?.symbol?.startsWith('function f('))
  assert.equal(outside?.symbol, '')
})

test('chunkText: assignment-form Ruby loops keep the enclosing method scope open', () => {
  const src = [
    'def f',
    '  value = while ready do',
    '    break 1',
    '  end',
    '  after_loop = value',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after_loop'))
  assert.equal(body?.symbol, 'def f')
})

test('chunkText: division before a regex literal does not end a function scope', () => {
  const src = [
    'function f() {',
    '  const x = foo() / ({}) / /}/;',
    '  return 1;',
    '}',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1'))
  assert.equal(body?.symbol, 'function f() {')
})

test('chunkText: multiline JavaScript control conditions allow a regex body', () => {
  const src = [
    'function f() {',
    '  if',
    '    (ready)',
    '      /}/.test(text)',
    '      keepScope()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('keepScope()'))
  assert.equal(body?.symbol, 'function f() {')
})

test('chunkText: export default ends a preceding arrow expression scope', () => {
  const src = ['const f = () => 1', 'export default handler'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const exported = chunks.find((chunk) => chunk.content.includes('export default handler'))
  assert.equal(exported?.symbol, '')
})

test('chunkText: Kotlin default lambda braces do not count as the function body', () => {
  const src = [
    'fun f(callback: () -> Unit = {})',
    '{',
    '  callback()',
    '}',
    'val unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('callback()'))
  assert.equal(body?.symbol, 'fun f(callback: () -> Unit = {})')
})

test('chunkText: escaped newlines do not leave JavaScript strings escaped', () => {
  const continuedString = '  const text = "first' + '\\'
  const src = [
    'function f() {',
    continuedString,
    '"',
    '  return text',
    '}',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside();'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: unindented TypeScript union continuations retain the alias symbol', () => {
  const src = ['type Result = Success |', 'Failure', 'const next = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('Failure'))
  assert.equal(continuation?.symbol, 'type Result = Success |')
})

test('chunkText: Ruby adjacent shift operators are not heredoc openers', () => {
  const src = [
    'def f',
    '  value = 1',
    '  value<<item',
    '  after_shift = value',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby spaced left shifts are not heredoc openers', () => {
  const src = [
    'def f',
    '  value = 1',
    '  value = 1 <<item',
    '  after_shift = value',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: a semicolon after a Ruby method header keeps its body labeled', () => {
  const src = ['def f;', '  value = 1', 'end', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('value = 1'))
  assert.equal(body?.symbol, 'def f;')
})

test('chunkText: Kotlin expression bodies continue after a trailing operator', () => {
  const src = ['fun f() = 1 +', '  2', 'val unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('  2'))
  assert.equal(continuation?.symbol, 'fun f() = 1 +')
})

test('chunkText: Scala expression bodies continue after a trailing operator', () => {
  const src = ['def f = 1 +', '  2', 'val unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('  2'))
  assert.equal(continuation?.symbol, 'def f = 1 +')
})

test('chunkText: Scala symbol literals in local method defaults do not leak the method symbol', () => {
  const src = [
    'def outer = {',
    "  def local(value: Symbol = 'fallback) = 1",
    '  println("outer")',
    '}',
    'after()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('println("outer")'))
  const after = chunks.find((chunk) => chunk.content.includes('after()'))
  assert.equal(body?.symbol, 'def outer = {')
  assert.equal(after?.symbol, '')
})

test('chunkText: JavaScript expression operators keep call-shaped continuations attached', () => {
  const src = ['const f = () => foo +', 'bar()', 'const unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('bar()'))
  assert.equal(continuation?.symbol, 'const f = () => foo +')
})

test('chunkText: Ruby symbol literals named end do not close methods', () => {
  const src = ['def f', '  value = :end', '  after = 1', 'end', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
  assert.equal(body?.symbol, 'def f')
})

test('chunkText: Java text blocks do not close enclosing method scopes', () => {
  const src = [
    'class Example {',
    '  void f() {',
    '    String text = """',
    '      quote " } still text',
    '      """;',
    '    return;',
    '  }',
    '  void outside() {}',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('Example.java'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return;'))
  assert.equal(body?.symbol, 'void f() {')
})

test('chunkText: Ruby endless predicate methods do not retain the class symbol', () => {
  const src = ['class Thing', '  def value?(input) = input', 'end', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('def value?'))
  const outside = chunks.find((chunk) => chunk.content === 'outside = 1')
  assert.equal(method?.symbol, 'def value?(input) = input')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby receiver-qualified endless methods do not label following code', () => {
  const src = ['def obj.foo = 1', 'outside = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('def obj.foo'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 2'))
  assert.equal(method?.symbol, 'def obj.foo = 1')
  assert.equal(outside?.symbol, '')
})

test('chunkText: export-list statements end prior arrow-expression symbols', () => {
  const src = ['const f = () => 1', 'export { f }'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const exported = chunks.find((chunk) => chunk.content.includes('export { f }'))
  assert.equal(exported?.symbol, '')
})

test('chunkText: escaped Bash braces do not end the function scope', () => {
  const src = [
    'function f() {',
    '  echo \\}',
    '  echo still_in_f',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('still_in_f'))
  assert.equal(body?.symbol, 'function f() {')
})

test('chunkText: Swift raw strings do not count embedded braces', () => {
  const src = [
    'func f() {',
    '  let text = #"quote " } still text"#',
    '  return text',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return text'))
  assert.equal(body?.symbol, 'func f() {')
})

test('chunkText: Swift raw regex braces do not keep function scopes open', () => {
  const src = [
    'func f() {',
    '  let pattern = #/\\{/#',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('let pattern'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'func f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Swift raw regex contents do not create function scopes', () => {
  const src = [
    'func outer() {',
    '  let pattern = #/',
    '    func fake() {',
    '  /#',
    '  print("inside")',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('print("inside")'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'func outer() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby embedded documentation does not alter method scope', () => {
  const src = [
    'def f',
    '=begin',
    'end',
    'def fake',
    '=end',
    '  after_doc = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after_doc'))
  const commentDeclaration = chunks.find((chunk) => chunk.content.includes('def fake'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(commentDeclaration?.symbol, 'def f')
})

test('chunkText: Ruby embedded documentation after a method does not inherit its scope', () => {
  const src = ['def f', '  1', 'end', '=begin', 'documentation', '=end', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('  1'))
  const documentation = chunks.find((chunk) => chunk.content.includes('documentation'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(method?.symbol, 'def f')
  assert.equal(documentation?.symbol, '')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby embedded documentation preserves endless expression continuations', () => {
  const src = [
    'def total = 1 +',
    '=begin',
    'comment text',
    '=end',
    '  2',
    'outside = 3',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('  2'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 3'))
  assert.equal(continuation?.symbol, 'def total = 1 +')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby embedded documentation after a completed endless method has no method symbol', () => {
  const src = [
    'def total = 1 +',
    '  2',
    '=begin',
    'documentation',
    '=end',
    'outside = 3',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('  2'))
  const documentation = chunks.find((chunk) => chunk.content.includes('documentation'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 3'))
  assert.equal(body?.symbol, 'def total = 1 +')
  assert.equal(documentation?.symbol, '')
  assert.equal(outside?.symbol, '')
})

test('chunkText: a local Kotlin expression function does not label peer calls', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '  println("outer")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const peer = chunks.find((chunk) => chunk.content.includes('println("outer")'))
  assert.equal(peer?.symbol, 'fun outer() {')
})

test('chunkText: a local Scala expression function does not label peer calls', () => {
  const src = [
    'def outer = {',
    '  def local = 1 +',
    '    2',
    '  println("outer")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const peer = chunks.find((chunk) => chunk.content.includes('println("outer")'))
  assert.equal(peer?.symbol, 'def outer = {')
})

test('chunkText: inline comments do not turn completed JavaScript expressions into continuations', () => {
  const src = ['const f = () => 1 // +', 'const unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const unrelated = chunks.find((chunk) => chunk.content.includes('const unrelated'))
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: code after a leading block comment ends the previous expression scope', () => {
  const src = ['const f = () => 1', '/* note */ const unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const unrelated = chunks.find((chunk) => chunk.content.includes('const unrelated'))
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: a multiline Kotlin default lambda does not count as the function body', () => {
  const src = [
    'fun f(callback: () -> Unit =',
    '  {',
    '    work()',
    '  }',
    ')',
    '{',
    '  callback()',
    '}',
    'val unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('callback()'))
  assert.equal(body?.symbol, 'fun f(callback: () -> Unit =')
})

test('chunkText: a balanced Kotlin default lambda before the body does not end the function scope', () => {
  const src = [
    'fun f(',
    '  callback: () -> Unit = { })',
    '{',
    '  body()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('body()'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'fun f(')
  assert.equal(outside?.symbol, '')
})

test('chunkText: nested Ruby blocks after then keep the method scope open', () => {
  const src = [
    'def f',
    '  if true then if true then 1 end end',
    '  after = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
  assert.equal(body?.symbol, 'def f')
})

test('chunkText: Ruby method headers with nested blocks keep the outer method scope open', () => {
  const src = [
    'def f; if ready',
    '  nested = 1',
    'end',
    '  after_if = 2',
    'end',
    'outside = 3',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after_if = 2'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 3'))
  assert.equal(body?.symbol, 'def f; if ready')
  assert.equal(outside?.symbol, '')
})

test('chunkText: code after a multiline JavaScript block comment ends the prior expression scope', () => {
  const src = [
    'const f = () => 1',
    '/* comment continues',
    ' */ const unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const unrelated = chunks.find((chunk) => chunk.content.includes('const unrelated'))
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: trailing comments do not keep bodyless Kotlin declarations active', () => {
  const src = [
    'interface Example {',
    '  fun compute() // no body',
    '}',
    'val unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const unrelated = chunks.find((chunk) => chunk.content.includes('val unrelated'))
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: backslashes in Bash single-quoted strings do not hide the closing brace', () => {
  const src = [
    'function f() {',
    "  echo 'literal \\'",
    '  echo still_in_f',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('still_in_f'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside=1'))
  assert.equal(body?.symbol, 'function f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Bash double-quoted escapes keep escaped quotes inside strings', () => {
  const quotedLine = ['  echo "literal ', '\\', '" still quoted"'].join('')
  const src = [
    'function f() {',
    quotedLine,
    '  echo still_in_f',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('still_in_f'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside=1'))
  assert.equal(body?.symbol, 'function f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: PHP heredoc braces do not close the enclosing function scope', () => {
  const src = [
    'function f() {',
    '  $text = <<<TEXT',
    '    } still heredoc text',
    'TEXT;',
    "  $literal = <<<'NOWDOC'",
    '    } still nowdoc text',
    'NOWDOC;',
    '  return 1;',
    '}',
    '$outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.php'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1;'))
  assert.equal(body?.symbol, 'function f() {')
})

test('chunkText: Python indentation scopes survive dedents inside parenthesized expressions', () => {
  const src = [
    'def f():',
    '    return (',
    '1',
    '    )',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.split('\n').includes('1'))
  assert.equal(continuation?.symbol, 'def f():')
})

test('chunkText: Python indentation scopes survive explicit line continuations', () => {
  const src = [
    'def f():',
    '    value = 1 + \\',
    '2',
    '    return value',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value'))
  assert.equal(body?.symbol, 'def f():')
})

test('chunkText: Kotlin bodies can open after the multiline signature closes', () => {
  const src = [
    'fun f(value: Int = 1',
    ') {',
    '  return value',
    '}',
    'val unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value'))
  assert.equal(body?.symbol, 'fun f(value: Int = 1')
})

test('chunkText: JavaScript update statements end prior arrow-expression scopes', () => {
  const src = ['const f = () => 1', 'counter++', 'const unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const update = chunks.find((chunk) => chunk.content.includes('counter++'))
  assert.equal(update?.symbol, '')
})

test('chunkText: C# verbatim strings keep doubled quotes and braces literal', () => {
  const src = [
    'class Example {',
    '  void f() {',
    '    var text = @"quote "" } still text";',
    '    return;',
    '  }',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('Example.cs'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return;'))
  assert.equal(body?.symbol, 'void f() {')
})

test('chunkText: Ruby endless methods with quoted bodies do not leak class symbols', () => {
  const src = [
    'class Thing',
    '  def value = "x"',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript regex literals do not look like trailing division operators', () => {
  const src = ['const f = () => /x/', 'const unrelated = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const unrelated = chunks.find((chunk) => chunk.content.includes('const unrelated'))
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: JavaScript do statements end prior arrow-expression scopes', () => {
  const src = [
    'const f = () => 1',
    'do { work() } while (again)',
    'const unrelated = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const loop = chunks.find((chunk) => chunk.content.includes('do {'))
  assert.equal(loop?.symbol, '')
})

test('chunkText: paired backslashes do not escape a Bash double-quote terminator', () => {
  const quotedLine = `  echo "literal ${String.fromCharCode(92).repeat(2)}"`
  const src = [
    'function f() {',
    quotedLine,
    '  echo still_in_f',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('still_in_f'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside=1'))
  assert.equal(body?.symbol, 'function f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: nested multiline TypeScript return types do not end the function scope', () => {
  const src = [
    'function f(): {',
    '  nested: { value: string }',
    '}',
    '{',
    '  return getValue()',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return getValue()'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(body?.symbol, 'function f(): {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Bash here-doc braces do not close the function scope', () => {
  const src = [
    'function f() {',
    '  cat <<EOF',
    '  }',
    'EOF',
    '  echo still_in_f',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('still_in_f'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside=1'))
  assert.equal(body?.symbol, 'function f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby backslash-newlines do not escape the next line quote', () => {
  const continuedString = ['  value = "inside', String.fromCharCode(92)].join('')
  const src = ['def f', continuedString, '"', '  after = 1', 'end', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Scala 3 indentation scopes end at the class dedent', () => {
  const src = ['class Foo:', '  println("inside")', 'println("outside")'].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const inside = chunks.find((chunk) => chunk.content.includes('println("inside")'))
  const outside = chunks.find((chunk) => chunk.content.includes('println("outside")'))
  assert.equal(inside?.symbol, 'class Foo:')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Scala 3 end markers use the enclosing indentation-scope symbol', () => {
  const src = [
    'object O:',
    '  def f =',
    '    1',
    'end O',
    'val outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const marker = chunks.find((chunk) => chunk.content.includes('end O'))
  const outside = chunks.find((chunk) => chunk.content.includes('val outside = 1'))
  assert.equal(marker?.symbol, 'object O:')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby outer locals updated inside blocks remain known for shift detection', () => {
  const src = [
    'def f',
    '  value = 0',
    '  [1].each do |item|',
    '    value = 1',
    '  end',
    '  value <<item',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('value <<item'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')

  const parameterSource = [
    'def g',
    '  [1].each do |item|',
    '    item <<item',
    '  end',
    '  item <<-TEXT',
    '    end',
    '  TEXT',
    'end',
    'outside = 1',
  ].join('\n')
  const parameterChunks = chunkText(parameterSource, languageForPath('a.rb'), { maxLines: 80 })
  const terminator = parameterChunks.find((chunk) => chunk.content.includes('  TEXT'))
  const afterMethod = parameterChunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(terminator?.symbol, 'def g')
  assert.equal(afterMethod?.symbol, '')
})

test('chunkText: Ruby block-only assignments do not hide later heredocs', () => {
  const src = [
    'def f',
    '  [1].each do |item|',
    '    value = item',
    '  end',
    '  value <<TEXT',
    'class Fake',
    'TEXT',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby instance-variable shifts are not heredoc openers', () => {
  const src = [
    'def f',
    '  @items = []',
    '  @items <<item',
    '  after = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: leading JavaScript semicolon expressions end prior arrow scopes', () => {
  const src = ['const f = () => 1', ';console.log("after")'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('console.log'))
  assert.equal(after?.symbol, '')
})

test('chunkText: bare Ruby method parameters are local for shift detection', () => {
  const src = [
    'def f value',
    '  value <<item',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript computed-member assignments end prior arrow scopes', () => {
  const src = ['const f = () => 1', 'cache[key] = value', 'const outside = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const assignment = chunks.find((chunk) => chunk.content.includes('cache[key]'))
  assert.equal(assignment?.symbol, '')
})

test('chunkText: nested generic return types do not end TypeScript function scopes', () => {
  const src = [
    'function f(): Promise<{ value: string }>',
    '{',
    '  return Promise.resolve({ value: "ok" })',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return Promise.resolve'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(body?.symbol, 'function f(): Promise<{ value: string }>')
  assert.equal(outside?.symbol, '')
})

test('chunkText: declarations inside Bash heredocs remain literal text', () => {
  const src = [
    'function outer() {',
    "  cat <<'EOF'",
    'function fake() {',
    '  echo fake',
    '}',
    'EOF',
    '  echo still_outer',
    '}',
    'echo outside',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const heredoc = chunks.find((chunk) => chunk.content.includes('echo fake'))
  const outside = chunks.find((chunk) => chunk.content.includes('echo outside'))
  assert.equal(heredoc?.symbol, 'function outer() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: bodyless TypeScript namespace functions do not leak past the namespace', () => {
  const src = [
    'declare namespace API {',
    '  function fetch(): string',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('function fetch'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(declaration?.symbol, 'function fetch(): string')
  assert.equal(outside?.symbol, '')
})

test('chunkText: top-level await expressions end prior JavaScript arrow scopes', () => {
  const src = ['const f = () => 1', 'await promise'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const awaited = chunks.find((chunk) => chunk.content.includes('await promise'))
  assert.equal(awaited?.symbol, '')
})

test('chunkText: declarations after leading block comments establish their symbol', () => {
  const src = [
    'const previous = () => 0',
    '/* note */ function visible() {',
    '  return 1',
    '}',
    'const outside = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(body?.symbol, 'function visible() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby brace-block parameters remain local until the closing brace', () => {
  const src = [
    'def f',
    '  [1].each { |item|',
    '    item <<item',
    '  }',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('item <<item'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Kotlin assignments end a preceding local expression-function symbol', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '  mutable = 2',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const assignment = chunks.find((chunk) => chunk.content.includes('mutable = 2'))
  assert.equal(assignment?.symbol, 'fun outer() {')
})

test('chunkText: Kotlin break and continue end prior local expression-function symbols', () => {
  for (const statement of ['break', 'continue']) {
    const src = [
      'fun outer() {',
      '  while (ready) {',
      '    fun local() = 1 +',
      '      2',
      `    ${statement}`,
      '    afterControl()',
      '  }',
      '}',
      'outside()',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
    const control = chunks.find((chunk) => chunk.content.includes(statement))
    const after = chunks.find((chunk) => chunk.content.includes('afterControl()'))
    const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
    assert.equal(control?.symbol, 'fun outer() {', statement)
    assert.equal(after?.symbol, 'fun outer() {', statement)
    assert.equal(outside?.symbol, '', statement)
  }
})

test('chunkText: Scala assignments end a preceding local expression-function symbol', () => {
  const src = [
    'def outer = {',
    '  def local = 1 +',
    '    2',
    '  mutable = 2',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const assignment = chunks.find((chunk) => chunk.content.includes('mutable = 2'))
  assert.equal(assignment?.symbol, 'def outer = {')
})

test('chunkText: quoted ambient TypeScript modules contain bodyless declarations', () => {
  const src = [
    'declare module "pkg" {',
    '  function getValue(): string',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: labeled JavaScript loop control statements end prior arrow scopes', () => {
  const src = [
    'outer: for (;;) {',
    '  const f = () => 1',
    '  continue outer',
    '}',
    'other: for (;;) {',
    '  const g = () => 1',
    '  break other',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const continued = chunks.find((chunk) => chunk.content.includes('continue outer'))
  const broken = chunks.find((chunk) => chunk.content.includes('break other'))
  assert.equal(continued?.symbol, '')
  assert.equal(broken?.symbol, '')
})

test('chunkText: Go function scopes ignore struct braces in multiline parameters and results', () => {
  const cases = [
    {
      lines: [
        'func read(',
        '  value struct {',
        '    name string',
        '  },',
        ') string {',
        '  return value.name',
        '}',
        'var outside = 1',
      ],
      declaration: 'func read(',
      bodyLine: 'return value.name',
    },
    {
      lines: [
        'func result() struct {',
        '  name string',
        '} {',
        '  return struct { name string }{name: "ok"}',
        '}',
        'var outside = 1',
      ],
      declaration: 'func result() struct {',
      bodyLine: 'return struct',
    },
  ] as const

  for (const { lines, declaration, bodyLine } of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath('a.go'), { maxLines: 80 })
    const body = chunks.find((chunk) => chunk.content.includes(bodyLine))
    const outside = chunks.find((chunk) => chunk.content.includes('var outside'))
    assert.equal(body?.symbol, declaration)
    assert.equal(outside?.symbol, '')
  }
})

test('chunkText: Swift function scopes ignore multiline closure defaults', () => {
  const src = [
    'func use(',
    '  callback: () -> Void = {',
    '  work()',
    '}',
    ') {',
    '  callback()',
    '}',
    'let outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('callback()'))
  const outside = chunks.find((chunk) => chunk.content.includes('let outside'))
  assert.equal(body?.symbol, 'func use(')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby documentation markers inside multiline literals stay literal', () => {
  const cases = [
    [
      'def f',
      '  text = "',
      '=begin',
      '"',
      '  after = 1',
      'end',
      'outside = 1',
    ],
    [
      'def f',
      '  text = %Q(',
      '=begin',
      ')',
      '  after = 1',
      'end',
      'outside = 1',
    ],
  ] as const

  for (const lines of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath('a.rb'), { maxLines: 80 })
    const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
    const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
    assert.equal(body?.symbol, 'def f')
    assert.equal(outside?.symbol, '')
  }
})

test('chunkText: Python scopes survive dedented lines inside dictionary literals', () => {
  const src = [
    'def f():',
    '    value = {',
    '1: 1,',
    '    }',
    '    return value',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f():')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Python floor division does not hide a dictionary opener', () => {
  const src = [
    'def outer():',
    '    result = a // {"k": b / c',
    '}',
    '    inside()',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('inside()'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'def outer():')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Scala 3 indentation scopes survive brace-delimited expression continuations', () => {
  const src = [
    'class Foo:',
    '  val value = {',
    '1',
    '  }',
    '  println(value)',
    'println("outside")',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('println(value)'))
  const outside = chunks.find((chunk) => chunk.content.includes('println("outside")'))
  assert.equal(body?.symbol, 'class Foo:')
  assert.equal(outside?.symbol, '')
})

test('chunkText: escaped JavaScript template newlines do not escape the closing delimiter', () => {
  const src = [
    ['const f = () => `line', String.fromCharCode(92)].join(''),
    '`',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: C# verbatim strings do not treat backslashes as escapes', () => {
  const src = [
    'class Example {',
    '  void f() {',
    ['    var text = @"text', String.fromCharCode(92), '";'].join(''),
    '    return;',
    '  }',
    '}',
    'var outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('Example.cs'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return;'))
  const outside = chunks.find((chunk) => chunk.content.includes('var outside'))
  assert.equal(body?.symbol, 'void f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: C# raw strings honor the exact quote delimiter length', () => {
  const src = [
    'class Example {',
    '  void f() {',
    '    var text = """"',
    '      void fake() { quote """ } still text',
    '      """";',
    '    return;',
    '  }',
    '}',
    'var outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('Example.cs'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return;'))
  const outside = chunks.find((chunk) => chunk.content.includes('var outside'))
  assert.equal(body?.symbol, 'void f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Swift function scopes continue through multiline effect and result clauses', () => {
  const src = [
    'func value() async',
    'throws -> Int {',
    '  return 1',
    '}',
    'let outside = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('let outside'))
  assert.equal(body?.symbol, 'func value() async')
  assert.equal(outside?.symbol, '')
})

test('chunkText: standalone JavaScript and TypeScript blocks end prior expression scopes', () => {
  const cases = [
    ['a.js', 'const f = () => 1;'],
    ['a.js', 'const f = () => 1'],
    ['a.ts', 'const f = () => 1;'],
    ['a.ts', 'const f = () => 1'],
  ] as const
  for (const [path, declaration] of cases) {
    const src = [
      declaration,
      '{',
      '  work();',
      '}',
      'const outside = 2',
    ].join('\n')
    const chunks = chunkText(src, languageForPath(path), { maxLines: 80 })
    const block = chunks.find((chunk) => chunk.content.includes('work();'))
    assert.equal(block?.symbol, '', path)
  }
})

test('chunkText: JavaScript and TypeScript member expressions end prior arrow scopes', () => {
  const cases = [
    ['a.js', 'object.value'],
    ['a.js', 'object?.()'],
    ['a.ts', 'object.value'],
    ['a.ts', 'object?.()'],
  ] as const
  for (const [path, statement] of cases) {
    const src = ['const f = () => 1', statement, 'const outside = 2'].join('\n')
    const chunks = chunkText(src, languageForPath(path), { maxLines: 80 })
    const member = chunks.find((chunk) => chunk.content.includes(statement))
    assert.equal(member?.symbol, '', `${path}: ${statement}`)
  }
})

test('chunkText: Kotlin expression bodies can start after the function signature', () => {
  const src = [
    'fun value(): Int',
    '  = 1',
    'val outside = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('= 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('val outside'))
  assert.equal(body?.symbol, 'fun value(): Int')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Scala bodyless methods with default parameters end at the trait boundary', () => {
  const src = [
    'trait Example {',
    '  def run(limit: Int = 1): Unit',
    '}',
    'val outside = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('def run'))
  const outside = chunks.find((chunk) => chunk.content.includes('val outside'))
  assert.equal(declaration?.symbol, 'def run(limit: Int = 1): Unit')
  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript declare-global functions do not leak outside the global block', () => {
  const src = [
    'export {}',
    'declare global {',
    '  function getValue(): string',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('function getValue'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(declaration?.symbol, 'function getValue(): string')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Kotlin try expressions end prior local expression-function scopes', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '  try {',
    '    work()',
    '  } catch (error: Exception) {',
    '    recover()',
    '  }',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const control = chunks.find((chunk) => chunk.content.includes('try {'))
  assert.equal(control?.symbol, 'fun outer() {')
})

test('chunkText: Scala 3 if-then expressions end prior local expression-function scopes', () => {
  const src = [
    'def outer = {',
    '  def local = 1 +',
    '    2',
    '  if condition then',
    '    println("outer")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const control = chunks.find((chunk) => chunk.content.includes('if condition then'))
  assert.equal(control?.symbol, 'def outer = {')
})

test('chunkText: TypeScript generic object return types do not end a multiline function scope', () => {
  const src = [
    'function f(): Promise<{',
    '  value: string',
    '}>',
    '{',
    '  return Promise.resolve({ value: "ok" })',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return Promise.resolve'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(body?.symbol, 'function f(): Promise<{')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby command strings do not close their enclosing method', () => {
  const src = [
    'def f',
    '  command = `echo end`',
    '  after = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript debugger statements end prior arrow-expression scopes', () => {
  const src = [
    'function withSemicolon() {',
    '  const local = () => 1 +',
    '    2',
    '  debugger;',
    '}',
    'function withoutSemicolon() {',
    '  const local = () => 1 +',
    '    2',
    '  debugger',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const terminated = chunks.find((chunk) => chunk.content.includes('debugger;'))
  const automaticSemicolon = chunks.find((chunk) => chunk.content.split('\n').some((line) => line.trim() === 'debugger'))
  assert.equal(terminated?.symbol, 'function withSemicolon() {')
  assert.equal(automaticSemicolon?.symbol, 'function withoutSemicolon() {')
})

test('chunkText: JavaScript case and default blocks end prior arrow-expression scopes', () => {
  const cases = [
    ['case 1: { caseWork() }', 'caseWork()'],
    ['default: { defaultWork() }', 'defaultWork()'],
  ] as const
  for (const [label, call] of cases) {
    const src = [
      'function outer(value) {',
      '  switch (value) {',
      '    case 0:',
      '      const local = () =>',
      '        finishLocal()',
      `    ${label}`,
      '  }',
      '}',
      'outside()',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
    const continued = chunks.find((chunk) => chunk.content.includes('finishLocal()'))
    const statement = chunks.find((chunk) => chunk.content.includes(call))
    const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
    assert.equal(continued?.symbol, 'const local = () =>', label)
    assert.equal(statement?.symbol, 'function outer(value) {', label)
    assert.equal(outside?.symbol, '', label)
  }
})

test('chunkText: JavaScript regex expression statements end prior arrow scopes', () => {
  const src = [
    'const f = () =>',
    '  1;',
    "/}/.test('}')",
    'const next = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const regex = chunks.find((chunk) => chunk.content.includes("/}/.test('}')"))
  const next = chunks.find((chunk) => chunk.content.includes('const next = 2'))
  assert.equal(regex?.symbol, '')
  assert.equal(next?.symbol, '')
})

test('chunkText: division after a JavaScript function expression preserves outer scope', () => {
  const src = [
    'function outer() {',
    '  const result = function() {} / divisor / /}/;',
    '  const after = 1;',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('const after = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(after?.symbol, 'function outer() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: regex literals after JavaScript break, continue, and debugger preserve scope', () => {
  for (const statement of ['break', 'continue', 'debugger']) {
    const src = [
      'function outer(values) {',
      '  for (const value of values) {',
      `    ${statement}`,
      '    /}/.test(value)',
      '    const stillInLoop = 1',
      '  }',
      '  const afterLoop = 2',
      '}',
      'outside()',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
    const regex = chunks.find((chunk) => chunk.content.includes('/}/.test(value)'))
    const after = chunks.find((chunk) => chunk.content.includes('afterLoop'))
    const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
    assert.equal(regex?.symbol, 'function outer(values) {', statement)
    assert.equal(after?.symbol, 'function outer(values) {', statement)
    assert.equal(outside?.symbol, '', statement)
  }
})

test('chunkText: Kotlin if and when statements end prior local expression-function scopes', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '  if (ready) {',
    '    work()',
    '  }',
    '  when (value) {',
    '    0 -> zero()',
    '    else -> other()',
    '  }',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const ifStatement = chunks.find((chunk) => chunk.content.includes('if (ready)'))
  const whenStatement = chunks.find((chunk) => chunk.content.includes('when (value)'))
  assert.equal(ifStatement?.symbol, 'fun outer() {')
  assert.equal(whenStatement?.symbol, 'fun outer() {')
})

test('chunkText: Scala 3 for-do and while-do statements end prior local expression-function scopes', () => {
  const src = [
    'def outer = {',
    '  def local = 1 +',
    '    2',
    '  for value <- values do',
    '    consume(value)',
    '  while ready do',
    '    tick()',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const forStatement = chunks.find((chunk) => chunk.content.includes('for value'))
  const whileStatement = chunks.find((chunk) => chunk.content.includes('while ready'))
  assert.equal(forStatement?.symbol, 'def outer = {')
  assert.equal(whileStatement?.symbol, 'def outer = {')
})

test('chunkText: TypeScript object return unions keep a function body attached', () => {
  const src = [
    'function f(): { value: string } | null {',
    '  return null',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return null'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'function f(): { value: string } | null {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: bodyless Go functions end before following declarations', () => {
  const src = ['func external()', 'var outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.go'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('func external()'))
  const outside = chunks.find((chunk) => chunk.content.includes('var outside'))
  assert.equal(declaration?.symbol, 'func external()')
  assert.equal(outside?.symbol, '')
})

test('chunkText: bodyless Go functions with qualified result types end before following declarations', () => {
  const src = ['func external() io.Reader', 'var outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.go'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('func external()'))
  const outside = chunks.find((chunk) => chunk.content.includes('var outside'))
  assert.equal(declaration?.symbol, 'func external() io.Reader')
  assert.equal(outside?.symbol, '')
})

test('chunkText: bodyless Go functions with composite result types end before following declarations', () => {
  for (const result of ['[]byte', 'map[string]int', 'func() error', '<-chan int']) {
    const declaration = `func external() ${result}`
    const src = [declaration, 'var outside = 1'].join('\n')
    const chunks = chunkText(src, languageForPath('a.go'), { maxLines: 80 })
    const declarationChunk = chunks.find((chunk) => chunk.content.includes(declaration))
    const outside = chunks.find((chunk) => chunk.content.includes('var outside'))
    assert.equal(declarationChunk?.symbol, declaration, declaration)
    assert.equal(outside?.symbol, '', declaration)
  }
})

test('chunkText: Kotlin bodyless generic methods with where clauses end at interface scope', () => {
  const src = [
    'interface Example {',
    '  fun <T> compare(value: T) where T : Comparable<T>',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('fun <T> compare'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(declaration?.symbol, 'fun <T> compare(value: T) where T : Comparable<T>')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Kotlin generic return types accept expression bodies on the next line', () => {
  const src = [
    'fun f(): List<String>',
    '= listOf("x")',
    'println("peer")',
    'fun after() {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('listOf("x")'))
  const peer = chunks.find((chunk) => chunk.content.includes('println("peer")'))
  const after = chunks.find((chunk) => chunk.content.includes('fun after()'))

  assert.equal(body?.symbol, 'fun f(): List<String>')
  assert.equal(peer?.symbol, '')
  assert.equal(after?.symbol, 'fun after() {}')
})

test('chunkText: Kotlin do statements end prior local expression-function scopes', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '  do {',
    '    work()',
    '  } while (ready)',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const statement = chunks.find((chunk) => chunk.content.includes('do {'))
  assert.equal(statement?.symbol, 'fun outer() {')
})

test('chunkText: Scala try statements end prior local expression-function scopes', () => {
  const src = [
    'def outer = {',
    '  def local = 1 +',
    '    2',
    '  try {',
    '    work()',
    '  } catch {',
    '    case error: Exception => recover()',
    '  }',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const statement = chunks.find((chunk) => chunk.content.includes('try {'))
  assert.equal(statement?.symbol, 'def outer = {')
})

test('chunkText: JavaScript array expression statements end prior arrow scopes', () => {
  const src = [
    'function outer() {',
    '  const local = () => 1 +',
    '    2;',
    '  [effect()].forEach(run)',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const statement = chunks.find((chunk) => chunk.content.includes('[effect()]'))
  assert.equal(statement?.symbol, 'function outer() {')
})

test('chunkText: Ruby endless methods retain scope through continued expressions', () => {
  const src = ['def total = 1 +', '  2', 'outside = 3'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('  2'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 3'))
  assert.equal(continuation?.symbol, 'def total = 1 +')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Swift signatures keep a result type after the arrow pending for the body', () => {
  const src = ['func value() ->', 'Int {', '  return 1', '}', 'let outside = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('let outside'))
  assert.equal(body?.symbol, 'func value() ->')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Swift protocol-composition result types can span lines before the body', () => {
  const src = [
    'protocol First {}',
    'protocol Second {}',
    'func make() -> any First &',
    '  Second {',
    '  fatalError()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('fatalError()'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'func make() -> any First &')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Scala result types can precede a body separator on the next line', () => {
  const src = ['def value: Int', '  = 1', 'println("outside")'].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('= 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('println("outside")'))
  assert.equal(body?.symbol, 'def value: Int')
  assert.equal(outside?.symbol, '')
})

test('chunkText: subjectless Kotlin when statements end prior local expression-function scopes', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '  when {',
    '    ready -> work()',
    '  }',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const statement = chunks.find((chunk) => chunk.content.includes('when {'))
  assert.equal(statement?.symbol, 'fun outer() {')
})

test('chunkText: Kotlin trailing-lambda calls end prior local expression-function scopes', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '  run {',
    '    work()',
    '  }',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const statement = chunks.find((chunk) => chunk.content.includes('run {'))
  assert.equal(statement?.symbol, 'fun outer() {')
})

test('chunkText: JavaScript labeled loops end prior arrow-expression scopes', () => {
  const src = [
    'function outer() {',
    '  const local = () => 1 +',
    '    2;',
    '  loop: for (;;) {',
    '    break loop',
    '  }',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const statement = chunks.find((chunk) => chunk.content.includes('loop: for'))
  assert.equal(statement?.symbol, 'function outer() {')
})

test('chunkText: Ruby endless methods keep multiline string bodies labeled', () => {
  const src = ['def value = "first line', 'second line"', 'outside = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('second line'))
  assert.equal(continuation?.symbol, 'def value = "first line')
})

test('chunkText: more-indented JavaScript peer statements end prior arrow scopes', () => {
  const src = [
    'function outer() {',
    '  const local = () => 1 +',
    '    2',
    '    console.log("peer")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const statement = chunks.find((chunk) => chunk.content.includes('console.log("peer")'))
  assert.equal(statement?.symbol, 'function outer() {')
})

test('chunkText: JavaScript yield statements end prior arrow-expression scopes', () => {
  const src = [
    'function* outer() {',
    '  const local = () => 1 +',
    '    2',
    '  yield 3',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const statement = chunks.find((chunk) => chunk.content.includes('yield 3'))
  assert.equal(statement?.symbol, 'function* outer() {')
})

test('chunkText: Scala lazy vals end prior local expression-function scopes', () => {
  const src = [
    'def outer = {',
    '  def local = 1 +',
    '    2',
    '  lazy val cached = 3',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('lazy val cached'))
  assert.equal(declaration?.symbol, 'def outer = {')
})

test('chunkText: ambient TypeScript default functions do not leak past modules', () => {
  const src = [
    'declare module "pkg" {',
    '  export default function getValue(): string',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('export default function getValue'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(declaration?.symbol, 'export default function getValue(): string')
  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript object return types can start on the line after the colon', () => {
  const src = [
    'function f():',
    '{',
    '  value: string',
    '}',
    '{',
    '  return { value: "ok" }',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return { value'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'function f():')
  assert.equal(outside?.symbol, '')
})

test('chunkText: named function expressions inside JavaScript template interpolation get scopes', () => {
  const src = [
    'const value = `prefix ${',
    '  function inner() {',
    '    return 1',
    '  }()',
    '}`',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1'))
  assert.equal(body?.symbol, 'function inner() {')
})

test('chunkText: multiline Rust trait methods end before the next method', () => {
  const src = [
    'trait Api {',
    '  fn run(',
    '    value: i32,',
    '  );',
    '  fn after();',
    '}',
    'fn outside() {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rs'), { maxLines: 80 })
  const closingBrace = chunks.find((chunk) => chunk.content.trim() === '}')
  const nextMethod = chunks.find((chunk) => chunk.content.includes('fn after();'))
  const outside = chunks.find((chunk) => chunk.content.includes('fn outside()'))
  assert.equal(closingBrace?.symbol, 'trait Api {')
  assert.equal(nextMethod?.symbol, 'fn after();')
  assert.equal(outside?.symbol, 'fn outside() {}')
})

test('chunkText: multiline Kotlin interface methods end before the next method', () => {
  const src = [
    'interface Example {',
    '  fun compare(',
    '    value: String,',
    '  ): Int',
    '  fun after()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: multiline Scala trait methods end before the next method', () => {
  const src = [
    'trait Example {',
    '  def compare(',
    '    value: String,',
    '  ): Int',
    '  def after(): Unit',
    '}',
    'println("outside")',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const nextMethod = chunks.find((chunk) => chunk.content.includes('def after(): Unit'))
  const outside = chunks.find((chunk) => chunk.content.includes('println("outside")'))
  assert.equal(nextMethod?.symbol, 'def after(): Unit')
  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript return types after multiline parameters stay with the function body', () => {
  const src = [
    'function f(',
    '  value: string,',
    ')',
    ': string {',
    '  return value',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'function f(')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby endless heredoc methods keep their label through the terminator', () => {
  const src = [
    'def value = <<~TEXT',
    '  body',
    'TEXT',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('  body'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def value = <<~TEXT')
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript arrow scopes end at the containing block closing brace', () => {
  const src = [
    'function outer() {',
    '  const local = () => 1',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const closingBrace = chunks.find((chunk) => chunk.content.split('\n').some((line) => line.trim() === '}'))
  assert.equal(closingBrace?.symbol, 'function outer() {')
})

test('chunkText: Ruby endless heredoc assignment-like text stays within the method', () => {
  const src = [
    'def value = <<~TEXT',
    '  preface',
    'rendered = "hello"',
    'TEXT',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('rendered ='))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def value = <<~TEXT')
  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript multiline object return types do not close the function scope', () => {
  const src = [
    'function f(',
    '  value: string,',
    '): Promise<{',
    '  result: string',
    '}>',
    '{',
    '  return Promise.resolve({ result: value })',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return Promise.resolve'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'function f(')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Rust multiline method where clauses retain the method symbol', () => {
  const src = [
    'trait Api {',
    '  fn compare(',
    '    value: &str,',
    '  )',
    '  where',
    '    Self: Sized;',
    '  fn after();',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rs'), { maxLines: 80 })
  const clause = chunks.find((chunk) => chunk.content.includes('where'))
  assert.equal(clause?.symbol, 'fn compare(')
})

test('chunkText: Kotlin multiline method where clauses retain the method symbol', () => {
  const src = [
    'interface Api {',
    '  fun <T> compare(',
    '    value: T,',
    '  ): T',
    '  where T : Comparable<T>',
    '  fun after()',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const clause = chunks.find((chunk) => chunk.content.includes('where T'))
  assert.equal(clause?.symbol, 'fun <T> compare(')
})

test('chunkText: Scala additional method parameter lists retain the method symbol', () => {
  const src = [
    'trait Api {',
    '  def compare(value: String)',
    '    (other: String): Int',
    '  def after(): Unit',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const secondParameters = chunks.find((chunk) => chunk.content.includes('(other: String)'))
  assert.equal(secondParameters?.symbol, 'def compare(value: String)')
})

test('chunkText: Rust bodyless methods with completed parameters end before outside code', () => {
  const src = [
    'trait Api {',
    '  fn compare(value: &str)',
    '  where Self: Sized;',
    '}',
    'fn outside() {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rs'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('fn compare'))
  const outside = chunks.find((chunk) => chunk.content.includes('fn outside()'))
  assert.equal(declaration?.symbol, 'fn compare(value: &str)')
  assert.equal(outside?.symbol, 'fn outside() {}')
})

test('chunkText: Rust return annotations on separate lines stay attached to function bodies', () => {
  const src = [
    'fn f()',
    '-> i32 {',
    '    1',
    '}',
    'fn outside() {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rs'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('    1'))
  const outside = chunks.find((chunk) => chunk.content.includes('fn outside()'))
  assert.equal(body?.symbol, 'fn f()')
  assert.equal(outside?.symbol, 'fn outside() {}')
})

test('chunkText: JavaScript regex literals preserve arrow-expression continuations', () => {
  const src = [
    'function outer() {',
    '  const local = () => /\\// +',
    '    call()',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('call()'))
  assert.equal(continuation?.symbol, 'const local = () => /\\// +')
})

test('chunkText: regex literals after JavaScript do statements preserve function scope', () => {
  const src = [
    'function outer(value) {',
    '  do /{/.test(value); while (value);',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('do /{/.test(value)'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'function outer(value) {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript overload signatures do not leak past their implementation', () => {
  const src = [
    'function lookup(value: string): string',
    'function lookup(value: number): number',
    'function lookup(value: string | number): string | number {',
    '  return value',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(body?.symbol, 'function lookup(value: string | number): string | number {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: strings inside Ruby interpolation do not close the surrounding method', () => {
  const src = [
    'def value',
    '  text = "#{ "end" }"',
    '  after = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def value')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby interpolation assignments keep local shifts distinct from heredocs', () => {
  const src = [
    'def f',
    '  "#{value = 1}"',
    '  value <<item',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const shift = chunks.find((chunk) => chunk.content.includes('value <<item'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(shift?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby interpolation assignments inside if and hash expressions remain locals', () => {
  const interpolations = [
    '"#{if true; value = 1; end}"',
    '"#{ { key: (value = 1) } }"',
  ]
  const nestedSymbols: Array<string | undefined> = []
  for (const interpolation of interpolations) {
    const src = [
      'def f',
      `  ${interpolation}`,
      '  value <<DOC',
      'def nested',
      '  work',
      'end',
      'DOC',
      'end',
      'def outside',
      '  work',
      'end',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
    const nested = chunks.find((chunk) => chunk.content.includes('def nested'))
    nestedSymbols.push(nested?.symbol)
  }
  assert.deepEqual(nestedSymbols, ['def nested', 'def nested'])
})

test('chunkText: Ruby compound interpolation assignments keep local shifts distinct from heredocs', () => {
  const src = [
    'def f',
    '  "#{value ||= 1}"',
    '  value <<item',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript regex braces survive division after an object literal', () => {
  const src = [
    'function outer() {',
    '  const result = {} / foo / /}/;',
    '  const after = 1',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('const after'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(after?.symbol, 'function outer() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript labeled blocks preserve regex scanning inside the function', () => {
  const src = [
    'function outer(value) {',
    '  label: {}',
    '  /}/.test(value)',
    '  const inside = 1',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const inside = chunks.find((chunk) => chunk.content.includes('const inside'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(inside?.symbol, 'function outer(value) {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Scala match expressions end a prior local expression scope', () => {
  const src = [
    'def outer = {',
    '  def local = 1 +',
    '    2',
    '  value match {',
    '    case _ => 3',
    '  }',
    '  afterMatch()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const matchCase = chunks.find((chunk) => chunk.content.includes('case _ => 3'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(matchCase?.symbol, 'def outer = {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Kotlin postfix updates end prior local expression-function scopes', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '  counter++',
    '  afterUpdate()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const update = chunks.find((chunk) => chunk.content.includes('counter++'))
  const after = chunks.find((chunk) => chunk.content.includes('afterUpdate()'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(update?.symbol, 'fun outer() {')
  assert.equal(after?.symbol, 'fun outer() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby endless methods with nested default calls end before following code', () => {
  const src = [
    'def f(value = make(1)) = value',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(chunks[0]?.symbol, 'def f(value = make(1)) = value')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby endless method assignments do not become class locals', () => {
  const src = [
    'class Example',
    '  def f = (name = 1)',
    '  name <<TEXT',
    '    end',
    '  TEXT',
    '  after = 1',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('after = 1'))
  assert.equal(after?.symbol, 'class Example')
})

test('chunkText: Ruby destructured block parameters are local for shift detection', () => {
  const src = [
    'def f',
    '  [1].each do |(value)|',
    '    value <<item',
    '  end',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('value <<item'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: multiline Ruby block parameters do not leave stale method labels', () => {
  const src = [
    'def f',
    '  [1].each do |item,',
    '                other|',
    '    item <<DOC',
    'end',
    'DOC',
    '    after = 1',
    '  end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(after?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: logical OR in multiline Ruby block defaults does not hide later parameters', () => {
  const src = [
    'def f',
    '  [1].each do |fallback = (nil || true),',
    '                item|',
    '    item <<DOC',
    'end',
    'DOC',
    '    after = 1',
    '  end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby endless methods retain labels through multiline delimited bodies', () => {
  const src = [
    'def value = combine(',
    '  first',
    ')',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('  first'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(continuation?.symbol, 'def value = combine(')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby endless methods keep multiline keyword-expression bodies labeled', () => {
  const src = [
    'def value = if ready',
    "  'yes'",
    'else',
    "  'no'",
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const consequent = chunks.find((chunk) => chunk.content.includes("'yes'"))
  const alternative = chunks.find((chunk) => chunk.content.includes("'no'"))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(consequent?.symbol, 'def value = if ready')
  assert.equal(alternative?.symbol, 'def value = if ready')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby endless method parameters are local for shift detection', () => {
  const src = [
    'def f(value) = value <<item',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(chunks[0]?.symbol, 'def f(value) = value <<item')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby block-local parameters after semicolons are local for shift detection', () => {
  const src = [
    'def f',
    '  [1].each do |item; buffer|',
    '    buffer <<entry',
    '  end',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('buffer <<entry'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: nested Ruby block parameters end at their own block boundary', () => {
  const src = [
    'def f',
    '  [1].each do |outer|; [2].each do |tmp|',
    '    work',
    '  end',
    '  tmp <<TEXT',
    'end',
    'TEXT',
    'after_block = 1',
    'end',
    'after_outer = 2',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const afterOuter = chunks.find((chunk) => chunk.content.includes('after_outer = 2'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(afterOuter?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby method locals after semicolons do not leak into outer heredoc detection', () => {
  const src = [
    'value = 0; def helper; render = 1; end',
    'render <<DOC',
    'class Fake',
    'DOC',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const heredoc = chunks.find((chunk) => chunk.content.includes('render <<DOC'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(heredoc?.symbol, '')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby parameters in methods after same-line definitions remain locals', () => {
  const src = [
    'def old; end; def newer(arg)',
    '  arg <<DOC',
    'def nested',
    '  work',
    'end',
    'DOC',
    'end',
    'def outside',
    '  work',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const nested = chunks.find((chunk) => chunk.content.includes('def nested'))
  assert.equal(nested?.symbol, 'def nested')
})

test('chunkText: top-level TypeScript declaration signatures end before following declarations', () => {
  const src = [
    'function lookup(value: string): string',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('types.d.ts'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(chunks[0]?.symbol, 'function lookup(value: string): string')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby comments do not continue an endless method expression', () => {
  const src = [
    'def value = 1 # comment +',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(chunks[0]?.symbol, 'def value = 1 # comment +')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby @end and $end assignments do not close a method scope', () => {
  const cases = [
    ['@end = 1', 'after_instance = 2'],
    ['$end = 1', 'after_global = 2'],
  ] as const
  for (const [assignment, following] of cases) {
    const src = ['def f', `  ${assignment}`, `  ${following}`, 'end', 'outside = 3'].join('\n')
    const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
    const body = chunks.find((chunk) => chunk.content.includes(following))
    const outside = chunks.find((chunk) => chunk.content.includes('outside = 3'))
    assert.equal(body?.symbol, 'def f', assignment)
    assert.equal(outside?.symbol, '', assignment)
  }
})

test('chunkText: JavaScript for-await blocks preserve regex scanning inside the function', () => {
  const src = [
    'async function outer(values) {',
    '  for await (const value of values) {}',
    '  /}/.test(value)',
    '  const inside = 1',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const inside = chunks.find((chunk) => chunk.content.includes('const inside'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(inside?.symbol, 'async function outer(values) {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby command-call regex arguments do not close the method', () => {
  const src = [
    'def f',
    '  puts /end/',
    '  after = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby endless methods preserve explicit escaped-newline continuations', () => {
  const src = [
    'def total = 1 + \\',
    '  2',
    'outside = 3',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('  2'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 3'))
  assert.equal(continuation?.symbol, 'def total = 1 + \\')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby command-call regex arguments stay distinct from division', () => {
  const cases = ['raise /end/', 'warn /end/']
  for (const command of cases) {
    const src = ['def f', `  ${command}`, '  after = 1', 'end', 'outside = 1'].join('\n')
    const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
    const body = chunks.find((chunk) => chunk.content.includes('after = 1'))
    const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
    assert.equal(body?.symbol, 'def f', command)
    assert.equal(outside?.symbol, '', command)
  }

  const divisionSrc = [
    'def f(value)',
    '  result = value / 2 / /end/',
    '  after = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const divisionChunks = chunkText(divisionSrc, languageForPath('a.rb'), { maxLines: 80 })
  const body = divisionChunks.find((chunk) => chunk.content.includes('after = 1'))
  const outside = divisionChunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f(value)')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby braces in multiline percent literals do not extend endless scopes', () => {
  const src = [
    'def value = %q[',
    '{',
    ']',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const literal = chunks.find((chunk) => chunk.content.includes('{'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(literal?.symbol, 'def value = %q[')
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript binary expression statements end prior arrow scopes', () => {
  const src = [
    'const f = () => 1',
    'foo + bar',
    'const unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const expression = chunks.find((chunk) => chunk.content.includes('foo + bar'))
  const unrelated = chunks.find((chunk) => chunk.content.includes('const unrelated'))
  assert.equal(expression?.symbol, '')
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: JavaScript and TypeScript no-argument constructors end prior arrow scopes', () => {
  for (const path of ['a.js', 'a.ts']) {
    const src = ['const f = () => 1', 'new Foo', 'const unrelated = 2'].join('\n')
    const chunks = chunkText(src, languageForPath(path), { maxLines: 80 })
    const constructor = chunks.find((chunk) => chunk.content.includes('new Foo'))
    const unrelated = chunks.find((chunk) => chunk.content.includes('const unrelated = 2'))
    assert.equal(constructor?.symbol, '', path)
    assert.equal(unrelated?.symbol, '', path)
  }
})

test('chunkText: JavaScript split relational expressions stay under the arrow symbol', () => {
  const src = ['const f = () => value >', '  0', 'const unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const operand = chunks.find((chunk) => chunk.content.includes('  0'))
  const unrelated = chunks.find((chunk) => chunk.content.includes('const unrelated = 2'))
  assert.equal(operand?.symbol, 'const f = () => value >')
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: a Bash comment backslash does not continue the command', () => {
  const src = [
    'function f() {',
    '  echo inside',
    '  # comment \\',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside=1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: Bash closing braces after a continued command remain arguments', () => {
  const src = [
    'function f() {',
    '  echo \\',
    '  }',
    '  echo still_in_f',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('still_in_f'))
  assert.equal(body?.symbol, 'function f() {')
})

test('chunkText: Bash function-like command arguments do not create scopes', () => {
  const src = [
    'function outer() {',
    '  echo \\',
    "  'function fake() {' \\",
    "  '}'",
    '  echo inside',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const argument = chunks.find((chunk) => chunk.content.includes('function fake()'))
  const body = chunks.find((chunk) => chunk.content.includes('echo inside'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside=1'))
  assert.equal(argument?.symbol, 'function outer() {')
  assert.equal(body?.symbol, 'function outer() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Kotlin literal peer expressions end local expression-function scopes', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '  42',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const peer = chunks.find((chunk) => chunk.content.includes('42'))
  assert.equal(peer?.symbol, 'fun outer() {')
})

test('chunkText: quoted Kotlin and Scala peer expressions end local expression-function scopes', () => {
  const cases = [
    ['a.kt', ['fun outer() {', '  fun local() = 1 +', '    2', '  "peer"', '  println("after")', '}'], 'fun outer() {'],
    ['a.scala', ['def outer = {', '  def local = 1 +', '    2', '  "peer"', '  println("after")', '}'], 'def outer = {'],
  ] as const
  for (const [path, lines, expectedSymbol] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    const peer = chunks.find((chunk) => chunk.content.includes('"peer"'))
    assert.equal(peer?.symbol, expectedSymbol, path)
  }
})

test('chunkText: Kotlin peer statements end local expression scopes regardless of indentation', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '        println("outer")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const peer = chunks.find((chunk) => chunk.content.includes('println("outer")'))
  assert.equal(peer?.symbol, 'fun outer() {')
})

test('chunkText: multiline TypeScript return annotations stay attached to function bodies', () => {
  const src = [
    'function f()',
    ': string {',
    "  return 'value'",
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes("return 'value'"))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'function f()')
  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript return types after a trailing colon stay attached to function bodies', () => {
  const src = [
    'function f():',
    'string {',
    "  return 'value'",
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes("return 'value'"))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'function f():')
  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript return annotations on separate lines stay attached to function bodies', () => {
  const src = [
    'function f()',
    ':',
    'string',
    '{',
    "  return 'value'",
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes("return 'value'"))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'function f()')
  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript object return types after a split signature stay attached to the function body', () => {
  const src = [
    'function f()',
    ': {',
    '  value: string',
    '}',
    '{',
    '  return { value: "ok" }',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return { value:'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(body?.symbol, 'function f()')
  assert.equal(outside?.symbol, '')
})

test('chunkText: bare and qualified Kotlin peer expressions end a local expression-function scope', () => {
  for (const expression of ['value', 'holder.value']) {
    const src = [
      'fun outer() {',
      '  fun local() = 1 +',
      '    2',
      `  ${expression}`,
      '}',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
    const peer = chunks.find((chunk) => chunk.content.includes(`  ${expression}`))
    assert.equal(peer?.symbol, 'fun outer() {', expression)
  }
})

test('chunkText: bare and qualified Scala peer expressions end a local expression-function scope', () => {
  for (const expression of ['value', 'holder.value']) {
    const src = [
      'def outer = {',
      '  def local = 1 +',
      '    2',
      `  ${expression}`,
      '}',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
    const peer = chunks.find((chunk) => chunk.content.includes(`  ${expression}`))
    assert.equal(peer?.symbol, 'def outer = {', expression)
  }
})

test('chunkText: ambient TypeScript functions start their own symbol scope', () => {
  const src = [
    'const f = () => 1',
    'declare function external(): void;',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('declare function external'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(declaration?.symbol, 'declare function external(): void;')
  assert.equal(outside?.symbol, '')
})

test('chunkText: semicolon-free ambient TypeScript functions end before following declarations', () => {
  const src = [
    'const f = () => 1',
    'declare function external(): void',
    'const outside = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('declare function external'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(declaration?.symbol, 'declare function external(): void')
  assert.equal(outside?.symbol, '')
})

test('chunkText: standalone blocks after ambient TypeScript functions do not inherit their symbol', () => {
  const src = [
    'declare function external(): void',
    '{',
    '  const value = 1',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('declare function external'))
  const block = chunks.find((chunk) => chunk.content.includes('const value = 1'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(declaration?.symbol, 'declare function external(): void')
  assert.equal(block?.symbol, '')
  assert.equal(outside?.symbol, '')
})

test('chunkText: split ambient TypeScript function parameters end before following code', () => {
  const src = [
    'declare function external',
    '  (value: string): void',
    'const outside = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const parameters = chunks.find((chunk) => chunk.content.includes('(value: string)'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside'))
  assert.equal(parameters?.symbol, 'declare function external')
  assert.equal(outside?.symbol, '')
})

test('chunkText: split ambient TypeScript return types keep their declaration symbol', () => {
  const cases = [
    {
      lines: ['declare function fetchThing(): Promise<', '  Result', '>', 'const after = 1'],
      symbol: 'declare function fetchThing(): Promise<',
    },
    {
      lines: ['declare function fetchOther', '  (): Promise<', '  Result', '>', 'const after = 1'],
      symbol: 'declare function fetchOther',
    },
  ]

  for (const { lines, symbol } of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath('a.d.ts'), { maxLines: 80 })
    const returnType = chunks.filter((chunk) => chunk.content.includes('Result') || chunk.content.trim() === '>')
    const after = chunks.find((chunk) => chunk.content.includes('const after = 1'))
    assert.ok(returnType.length > 0)
    for (const chunk of returnType) assert.equal(chunk.symbol, symbol)
    assert.equal(after?.symbol, '')
  }
})

test('chunkText: ambient TypeScript union return continuations keep their declaration symbol', () => {
  const src = [
    'declare function fetchValue():',
    '  First |',
    '  Second',
    'const after = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.d.ts'), { maxLines: 80 })
  const first = chunks.find((chunk) => chunk.content.includes('First |'))
  const second = chunks.find((chunk) => chunk.content.includes('Second'))
  const after = chunks.find((chunk) => chunk.content.includes('const after = 1'))
  assert.equal(first?.symbol, 'declare function fetchValue():')
  assert.equal(second?.symbol, 'declare function fetchValue():')
  assert.equal(after?.symbol, '')
})

test('chunkText: Scala symbol literals do not leave the enclosing brace scope open', () => {
  const src = [
    'def outer = {',
    "  val name = 'symbol",
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: Unicode Scala symbol literals do not leave the enclosing brace scope open', () => {
  const src = [
    'object O {',
    '  def outer = {',
    "    val name = 'α",
    '    work()',
    '  }',
    '  val outside = 1',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('val outside = 1'))
  assert.equal(outside?.symbol, 'object O {')
})

test('chunkText: Scala 3 term and type quotes preserve enclosing brace scopes', () => {
  const outsideSymbols: Array<string | undefined> = []
  for (const quote of ["'{ val x = 1 }", "'[List[Int]]"]) {
    const src = [
      'object O {',
      '  def f = {',
      `    val quoted = ${quote}`,
      '    work()',
      '  }',
      '  val outside = 1',
      '}',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
    const outside = chunks.find((chunk) => chunk.content.includes('val outside = 1'))
    outsideSymbols.push(outside?.symbol)
  }
  assert.deepEqual(outsideSymbols, ['object O {', 'object O {'])
})

test('chunkText: Kotlin expression functions keep multiline if branches under their symbol', () => {
  const src = [
    'fun outer() {',
    '  fun choose(value: Int) = if (value > 0)',
    '    value',
    '  else',
    '    -value',
    '  println("after")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const branch = chunks.find((chunk) => chunk.content.includes('    value'))
  const alternative = chunks.find((chunk) => chunk.content.includes('    -value'))
  const after = chunks.find((chunk) => chunk.content.includes('println("after")'))
  assert.equal(branch?.symbol, 'fun choose(value: Int) = if (value > 0)')
  assert.equal(alternative?.symbol, 'fun choose(value: Int) = if (value > 0)')
  assert.equal(after?.symbol, 'fun outer() {')
})

test('chunkText: Scala 3 expression functions keep multiline if branches under their symbol', () => {
  const src = [
    'def outer = {',
    '  def choose(value: Int) = if value > 0 then',
    '    value',
    '  else',
    '    -value',
    '  println("after")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const branch = chunks.find((chunk) => chunk.content.includes('    value'))
  const alternative = chunks.find((chunk) => chunk.content.includes('    -value'))
  const after = chunks.find((chunk) => chunk.content.includes('println("after")'))
  assert.equal(branch?.symbol, 'def choose(value: Int) = if value > 0 then')
  assert.equal(alternative?.symbol, 'def choose(value: Int) = if value > 0 then')
  assert.equal(after?.symbol, 'def outer = {')
})

test('chunkText: Kotlin if expressions keep a branch after a trailing else under the function symbol', () => {
  const src = ['fun choose() = if (ready) 1 else', '  2', 'fun outside() {}'].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const branch = chunks.find((chunk) => chunk.content.includes('  2'))
  assert.equal(branch?.symbol, 'fun choose() = if (ready) 1 else')
})

test('chunkText: Scala 3 if expressions keep a branch after a trailing else under the declaration symbol', () => {
  const src = ['def choose = if ready then 1 else', '  2', 'def outside = 0'].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const branch = chunks.find((chunk) => chunk.content.includes('  2'))
  assert.equal(branch?.symbol, 'def choose = if ready then 1 else')
})

test('chunkText: same-line JavaScript blocks end prior arrow-expression scopes', () => {
  const src = [
    'const f = () => 1',
    '{ work() }',
    'const unrelated = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const block = chunks.find((chunk) => chunk.content.includes('{ work() }'))
  assert.equal(block?.symbol, '')
})

test('chunkText: PHP semicolon namespaces label file-scoped statements', () => {
  const src = [
    '<?php',
    'namespace Acme;',
    '$service = new Service();',
    'namespace Other;',
    '$other = new Other();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.php'), { maxLines: 80 })
  const service = chunks.find((chunk) => chunk.content.includes('$service'))
  const other = chunks.find((chunk) => chunk.content.includes('$other'))
  assert.equal(service?.symbol, 'namespace Acme;')
  assert.equal(other?.symbol, 'namespace Other;')
})

test('chunkText: PHP namespace-like heredoc lines do not end the namespace scope', () => {
  const src = [
    '<?php',
    'namespace Acme;',
    '$text = <<<TXT',
    'namespace Other;',
    'TXT;',
    '$after = 1;',
    'namespace Final;',
    '$other = 2;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.php'), { maxLines: 80 })
  const heredoc = chunks.find((chunk) => chunk.content.includes('namespace Other;'))
  const after = chunks.find((chunk) => chunk.content.includes('$after'))
  assert.equal(heredoc?.symbol, 'namespace Acme;')
  assert.equal(after?.symbol, 'namespace Acme;')
})

test('chunkText: braces in PHP inline HTML do not end the PHP function scope', () => {
  const src = [
    '<?php',
    'function outer() {',
    '?>',
    '}',
    '<?php',
    '  return 1;',
    '}',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.php'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1;'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside();'))
  assert.equal(body?.symbol, 'function outer() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: PHP inline HTML after a closed function has no function symbol', () => {
  const src = ['<?php', 'function f() { return 1; } ?>', 'outside();'].join('\n')
  const chunks = chunkText(src, languageForPath('a.php'), { maxLines: 80 })
  const functionChunk = chunks.find((chunk) => chunk.content.includes('function f()'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside();'))
  assert.equal(functionChunk?.symbol, 'function f() { return 1; } ?>')
  assert.equal(outside?.symbol, '')
})

test('chunkText: PHP close tags inside strings, block comments, and heredocs stay literal', () => {
  const src = [
    '<?php',
    'function outer() {',
    '  $string = "?>";',
    '  /* ?> { } */',
    '  $text = <<<TEXT',
    '?> { }',
    'TEXT;',
    '  return 1;',
    '}',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.php'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1;'))
  assert.equal(body?.symbol, 'function outer() {')
})

test('chunkText: comments after a closed function do not retain its symbol', () => {
  const src = [
    'function outer() {',
    '  work();',
    '}',
    '',
    '// top-level explanation',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const functionChunk = chunks.find((chunk) => chunk.content.includes('work();'))
  const comment = chunks.find((chunk) => chunk.content.includes('// top-level explanation'))
  assert.equal(functionChunk?.content.endsWith('\n'), true)
  assert.equal(functionChunk?.symbol, 'function outer() {')
  assert.equal(comment?.symbol, '')
})

test('chunkText: Objective-C interface and implementation scopes end at @end', () => {
  for (const declaration of ['@interface Foo', '@implementation Foo', '@protocol Foo']) {
    const src = [declaration, '@end', 'int outside = 1;'].join('\n')
    const chunks = chunkText(src, languageForPath('a.m'), { maxLines: 80 })
    const scope = chunks.find((chunk) => chunk.content.includes(declaration))
    const outside = chunks.find((chunk) => chunk.content.includes('int outside'))
    assert.equal(scope?.symbol, declaration, declaration)
    assert.equal(outside?.symbol, '', declaration)
  }
})

test('chunkText: unary-sign peer expressions end JavaScript, Kotlin, and Scala expression scopes', () => {
  const cases = [
    ['a.js', ['const f = () => 1;', '-42;', '+42;', 'const unrelated = 2'], '-42', ''],
    ['a.kt', ['fun outer() {', '  fun local() = 1;', '  -42;', '  +42;', '  println("after")', '}'], '-42', 'fun outer() {'],
    ['a.scala', ['def outer = {', '  def local = 1;', '  -42;', '  +42;', '  println("after")', '}'], '-42', 'def outer = {'],
  ] as const

  for (const [path, lines, expression, expectedSymbol] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    const signExpression = chunks.find((chunk) => chunk.content.includes(expression))
    assert.equal(signExpression?.symbol, expectedSymbol, path)
  }
})

test('chunkText: JavaScript unary-looking lines continue arrow expressions without semicolons', () => {
  const src = ['const f = () => 1', '-42', 'const unrelated = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('-42'))
  const unrelated = chunks.find((chunk) => chunk.content.includes('const unrelated = 2'))
  assert.equal(continuation?.symbol, 'const f = () => 1')
  assert.equal(unrelated?.symbol, '')
})

test('chunkText: multiline JavaScript control blocks preserve following regex brace scope', () => {
  const src = [
    'function outer() {',
    '  if (',
    '    condition',
    '  ) {',
    '    work()',
    '  }',
    '  /}/.test(value)',
    '  afterRegex()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const afterRegex = chunks.find((chunk) => chunk.content.includes('afterRegex()'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(afterRegex?.symbol, 'function outer() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Kotlin safe-call peer statements end expression-function scopes', () => {
  const src = [
    'fun outer() {',
    '  fun local() =',
    '    1',
    '  receiver?.invoke()',
    '  println("after")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const safeCall = chunks.find((chunk) => chunk.content.includes('receiver?.invoke()'))
  assert.equal(safeCall?.symbol, 'fun outer() {')
})

test('chunkText: Kotlin and Scala unary-not peers end expression-function scopes', () => {
  const cases = [
    ['a.kt', ['fun outer() {', '  fun local() =', '    1', '  !flag', '  println("after")', '}']],
    ['a.scala', ['def outer = {', '  def local =', '    1', '  !flag', '  println("after")', '}']],
  ] as const
  for (const [path, lines] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    const negation = chunks.find((chunk) => chunk.content.includes('!flag'))
    const expected = path.endsWith('.kt') ? 'fun outer() {' : 'def outer = {'
    assert.equal(negation?.symbol, expected, path)
  }
})

test('chunkText: async JavaScript function declarations end prior expression scopes', () => {
  const src = [
    'const f = () => 1',
    'async function g() {',
    '  work()',
    '}',
    '// outside comment',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const comment = chunks.find((chunk) => chunk.content.includes('// outside comment'))
  assert.equal(comment?.symbol, '')
})

test('chunkText: tagged templates end prior JavaScript expression scopes', () => {
  const src = ['const f = () => 1', 'tag`peer`', 'const after = 2'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const taggedTemplate = chunks.find((chunk) => chunk.content.includes('tag`peer`'))
  assert.equal(taggedTemplate?.symbol, '')
})

test('chunkText: Scala constructor peers end local expression-function scopes', () => {
  const src = [
    'def outer = {',
    '  def local =',
    '    1',
    '  new Foo()',
    '  println("after")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const constructor = chunks.find((chunk) => chunk.content.includes('new Foo()'))
  assert.equal(constructor?.symbol, 'def outer = {')
})

test('chunkText: same-line Objective-C @end closes the interface symbol', () => {
  const src = ['@interface Foo @end', 'int outside = 1;'].join('\n')
  const chunks = chunkText(src, languageForPath('a.m'), { maxLines: 80 })
  const scope = chunks.find((chunk) => chunk.content.includes('@interface Foo'))
  const outside = chunks.find((chunk) => chunk.content.includes('int outside'))
  assert.equal(scope?.symbol, '@interface Foo @end')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Objective-C @end text in strings and comments does not close a scope', () => {
  const src = [
    '@implementation Foo',
    '- (void)run {',
    '  NSString *message = @"@end"; // @end',
    '  /* @end */',
    '  int inside = 1;',
    '}',
    '@end',
    'int outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.m'), { maxLines: 80 })
  const inside = chunks.find((chunk) => chunk.content.includes('int inside'))
  const outside = chunks.find((chunk) => chunk.content.includes('int outside'))
  assert.equal(inside?.symbol, '- (void)run {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Objective-C method comments do not leave a method scope above @end', () => {
  const src = [
    '@interface Foo',
    '- (void)run; // method',
    '@end',
    'int outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.m'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('- (void)run'))
  const outside = chunks.find((chunk) => chunk.content.includes('int outside'))
  assert.equal(method?.symbol, '- (void)run; // method')
  assert.equal(outside?.symbol, '')
})

test('chunkText: PHP namespace scope survives a trailing hash comment', () => {
  const src = [
    '<?php',
    'namespace Acme; # comment',
    'class Foo {}',
    '$after = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.php'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('$after'))
  assert.equal(after?.symbol, 'namespace Acme;')
})

test('chunkText: parenthesized Kotlin and Scala peers end expression-function scopes', () => {
  const cases = [
    ['a.kt', ['fun outer() {', '  fun local() =', '    1;', '  (println("peer"))', '  println("after")', '}'], 'fun outer() {'],
    ['a.scala', ['def outer = {', '  def local =', '    1;', '  (println("peer"))', '  println("after")', '}'], 'def outer = {'],
  ] as const
  for (const [path, lines, expected] of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath(path), { maxLines: 80 })
    const peer = chunks.find((chunk) => chunk.content.includes('(println("peer"))'))
    assert.equal(peer?.symbol, expected, path)
  }
})

test('chunkText: nested strings in Kotlin interpolation do not close the function scope', () => {
  const src = [
    'fun outer() {',
    '  val text = "${format("}}")}"',
    '  work()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('work()'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'fun outer() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Objective-C @end inside a continued string does not close the interface', () => {
  const continuedString = '  NSString *message = @"continued ' + '\\'
  const continuedEnd = '  @end' + '\\'
  const src = [
    '@implementation Foo',
    '- (void)run {',
    continuedString,
    continuedEnd,
    '  ";',
    '  int inside = 1;',
    '}',
    '@end',
    'int outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.m'), { maxLines: 80 })
  const inside = chunks.find((chunk) => chunk.content.includes('int inside'))
  const outside = chunks.find((chunk) => chunk.content.includes('int outside'))
  assert.equal(inside?.symbol, '- (void)run {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Objective-C directives containing @end do not close interface scopes', () => {
  const directives = [
    ['#define UNUSED @end'],
    ['#define UNUSED \\', '  @end'],
    ['/* note */ #define UNUSED @end'],
  ] as const
  for (const directive of directives) {
    const src = [
      '@interface Foo',
      ...directive,
      'int inside = 1;',
      '@end',
      'int outside = 1;',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.m'), { maxLines: 80 })
    const inside = chunks.find((chunk) => chunk.content.includes('int inside'))
    const outside = chunks.find((chunk) => chunk.content.includes('int outside'))
    assert.equal(inside?.symbol, '@interface Foo', directive[0])
    assert.equal(outside?.symbol, '')
  }
})

test('chunkText: Ruby predicate methods end without breaking ternary continuations', () => {
  const src = [
    'def check = ready?',
    'outside = 1',
    'def choose = ready ?',
    '  1 : 2',
    'after = 3',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  const ternary = chunks.find((chunk) => chunk.content.includes('  1 : 2'))
  const after = chunks.find((chunk) => chunk.content.includes('after = 3'))
  assert.equal(outside?.symbol, '')
  assert.equal(ternary?.symbol, 'def choose = ready ?')
  assert.equal(after?.symbol, '')
})

test('chunkText: completed JavaScript expressions end before trailing EOF comments', () => {
  for (const path of ['a.js', 'a.ts']) {
    const src = ['const f = () => 1', '// note'].join('\n')
    const chunks = chunkText(src, languageForPath(path), { maxLines: 80 })
    const comment = chunks.find((chunk) => chunk.content.includes('// note'))
    assert.equal(comment?.symbol, '', path)
  }

  const continued = chunkText(
    ['const f = () => 1 +', '// unfinished'].join('\n'),
    languageForPath('a.js'),
    { maxLines: 80 },
  )
  const comment = continued.find((chunk) => chunk.content.includes('// unfinished'))
  assert.equal(comment?.symbol, 'const f = () => 1 +')
})

test('chunkText: completed Kotlin expression scopes end before trailing EOF comments', () => {
  const sources = [
    ['fun f() =', '  1', '// note'],
    ['fun f() =', '  1', '// note', 'val after = 2'],
  ]
  for (const lines of sources) {
    const chunks = chunkText(lines.join('\n'), languageForPath('a.kt'), { maxLines: 80 })
    const comment = chunks.find((chunk) => chunk.content.includes('// note'))
    assert.equal(comment?.symbol, '')
  }
})

test('chunkText: PHP interface methods can terminate on the following line', () => {
  const src = [
    '<?php',
    'interface Foo {',
    '  public function run()',
    '  ;',
    '}',
    '$outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.php'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('public function run()'))
  const outside = chunks.find((chunk) => chunk.content.includes('$outside'))
  assert.equal(declaration?.symbol, 'public function run()')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Objective-C method declarations can terminate on the following line', () => {
  const src = [
    '@interface Foo',
    '- (void)run:(id)value',
    ';',
    '@end',
    'int outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.m'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('- (void)run'))
  const outside = chunks.find((chunk) => chunk.content.includes('int outside'))
  assert.equal(declaration?.symbol, '- (void)run:(id)value')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Objective-C multiline selector continuations keep the method symbol', () => {
  const src = [
    '@interface Foo',
    '- (void)run:(id)value',
    'with:(id)other;',
    '@end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.m'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('with:(id)other;'))
  assert.equal(continuation?.symbol, '- (void)run:(id)value')
})

test('chunkText: Objective-C multiline method implementations keep the body symbol', () => {
  const src = [
    '@implementation Foo',
    '- (void)run:(id)value',
    'with:(id)other {',
    '  [self work];',
    '}',
    '@end',
    'int outside;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.m'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('[self work];'))
  const outside = chunks.find((chunk) => chunk.content.includes('int outside;'))
  assert.equal(body?.symbol, '- (void)run:(id)value')
  assert.equal(outside?.symbol, '')
})

test('chunkText: embedded quotes in Python triple-quoted defaults preserve the header colon', () => {
  const src = [
    'def f(x: str = """a " # b"""):',
    '    return x',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: labeled Kotlin loops end prior expression-function scopes', () => {
  const src = [
    'fun outer() {',
    '  fun local() =',
    '    1',
    '  loop@ while (condition) {',
    '    work()',
    '  }',
    '  println("after")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const loop = chunks.find((chunk) => chunk.content.includes('loop@ while'))
  assert.equal(loop?.symbol, 'fun outer() {')
})

test('chunkText: JavaScript arrow expression scope ends before a trailing comment', () => {
  const src = ['const f = () => 1', '// trailing comment', 'outside()'].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const comment = chunks.find((chunk) => chunk.content.includes('// trailing comment'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(comment?.symbol, '')
  assert.equal(outside?.symbol, '')
})

test('chunkText: completed JavaScript arrow expressions end before multiline block comments', () => {
  const src = [
    'const f = () => 1 /*',
    ' * trailing',
    ' */',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const comment = chunks.find((chunk) => chunk.content.includes('trailing'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(comment?.symbol, '')
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript block-comment contents do not end an arrow continuation', () => {
  const src = [
    'const f = () => 1',
    '// trailing',
    '/*',
    'outside()',
    '*/',
    '+ 2',
    'const after = 3',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const comment = chunks.find((chunk) => chunk.content.includes('// trailing'))
  const continuation = chunks.find((chunk) => chunk.content.includes('+ 2'))
  const after = chunks.find((chunk) => chunk.content.includes('const after = 3'))
  assert.equal(comment?.symbol, 'const f = () => 1')
  assert.equal(continuation?.symbol, 'const f = () => 1')
  assert.equal(after?.symbol, '')
})

test('chunkText: Kotlin annotations belong to the following declaration after an expression body', () => {
  const src = [
    'fun value() = if (ready)',
    '  "yes"',
    'else',
    '  "no"',
    '@Deprecated("Use replacement")',
    'fun replacement() = "done"',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const annotation = chunks.find((chunk) => chunk.content.includes('@Deprecated'))
  const declaration = chunks.find((chunk) => chunk.content.includes('fun replacement()'))
  assert.equal(annotation?.symbol, 'fun replacement() = "done"')
  assert.equal(declaration?.symbol, 'fun replacement() = "done"')
})

test('chunkText: multiline Kotlin annotations stay attached to their declaration', () => {
  const src = [
    '@Deprecated(',
    '  message = "Use replacement"',
    ')',
    'fun replacement() = "done"',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const annotation = chunks.find((chunk) => chunk.content.includes('@Deprecated('))
  const annotationArguments = chunks.find((chunk) => chunk.content.includes('message ='))
  const declaration = chunks.find((chunk) => chunk.content.includes('fun replacement()'))
  assert.equal(annotation?.symbol, 'fun replacement() = "done"')
  assert.equal(annotationArguments?.symbol, 'fun replacement() = "done"')
  assert.equal(declaration?.symbol, 'fun replacement() = "done"')
})

test('chunkText: Kotlin file annotations are not attached to the first declaration', () => {
  const src = ['@file:JvmName("Generated")', 'fun first() = 1'].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const fileAnnotation = chunks.find((chunk) => chunk.content.includes('@file:'))
  const declaration = chunks.find((chunk) => chunk.content.includes('fun first()'))
  assert.equal(fileAnnotation?.symbol, '')
  assert.equal(declaration?.symbol, 'fun first() = 1')
})

test('chunkText: multiline triple-quoted Python defaults close the function header', () => {
  const src = [
    'def f(x="""first',
    ':',
    '"""):',
    '    return x',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: Kotlin identifier-led binary peers end local expression scopes', () => {
  const src = [
    'fun outer() {',
    '  fun local() =',
    '    1',
    '  value + other',
    '  println("after")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const peer = chunks.find((chunk) => chunk.content.includes('value + other'))
  assert.equal(peer?.symbol, 'fun outer() {')
})

test('chunkText: Scala identifier-led binary peers end local expression scopes', () => {
  const src = [
    'def outer = {',
    '  def local =',
    '    1',
    '  value + other',
    '  println("after")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const peer = chunks.find((chunk) => chunk.content.includes('value + other'))
  assert.equal(peer?.symbol, 'def outer = {')
})

test('chunkText: Scala given declarations end local expression scopes', () => {
  const src = [
    'def outer = {',
    '  def local =',
    '    1',
    '  given Ordering[Int] = Ordering.Int',
    '  println("after")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const given = chunks.find((chunk) => chunk.content.includes('given Ordering'))
  assert.equal(given?.symbol, 'def outer = {')
})

test('chunkText: generic TypeScript constructors end prior arrow scopes', () => {
  const src = [
    'const local = () => 1',
    'new Foo<string>()',
    'const after = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const constructor = chunks.find((chunk) => chunk.content.includes('new Foo<string>()'))
  const after = chunks.find((chunk) => chunk.content.includes('const after = 2'))
  assert.equal(constructor?.symbol, '')
  assert.equal(after?.symbol, '')
})

test('chunkText: Scala comment lookahead preserves indentation for expression continuations', () => {
  const src = [
    'def outer =',
    '  def local =',
    '    1',
    '    // note',
    '    + 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const continuation = chunks.find((chunk) => chunk.content.includes('+ 2'))
  assert.equal(continuation?.symbol, 'def local =')
})

test('chunkText: Scala block-comment code columns preserve the nested symbol scope', () => {
  const src = [
    'def outer =',
    '  def local =',
    '    1',
    '  // note',
    '/* comment */       val peer = 2',
    '  println("after")',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const peer = chunks.find((chunk) => chunk.content.includes('val peer'))
  assert.equal(peer?.symbol, 'def local =')
})

test('chunkText: Scala peer statements count indentation before a leading block comment', () => {
  const src = [
    'def outer = {',
    '  def local =',
    '    1',
    ' /* comment */ println("peer")',
    '  println("after")',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const peer = chunks.find((chunk) => chunk.content.includes('println("peer")'))
  const after = chunks.find((chunk) => chunk.content.includes('println("after")'))
  assert.equal(peer?.symbol, 'def outer = {')
  assert.equal(after?.symbol, 'def outer = {')
})

test('chunkText: standalone single-parameter arrows end prior expression scopes', () => {
  const cases = [
    ['a.js', 'x => x'],
    ['a.js', 'async x => x'],
    ['a.ts', 'x => x'],
    ['a.ts', 'async x => x'],
  ] as const
  for (const [path, expression] of cases) {
    const src = ['const f = () => 1', expression, 'const after = 2'].join('\n')
    const chunks = chunkText(src, languageForPath(path), { maxLines: 80 })
    const arrow = chunks.find((chunk) => chunk.content.includes(expression))
    assert.equal(arrow?.symbol, '', `${path}: ${expression}`)
  }
})

test('chunkText: split TypeScript return colons keep object-type function bodies labeled', () => {
  const src = [
    'function f()',
    ':',
    '  { value: number }',
    '{',
    '  return { value: 1 }',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return { value: 1 }'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside = 1'))
  assert.equal(body?.symbol, 'function f()')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby locals assigned after same-line block ends stay in the enclosing scope', () => {
  const src = [
    'def f',
    '  [1].each do |item|',
    '    puts item',
    '  end; value = 1',
    '  puts value <<DOC',
    'def nested',
    'end',
    'DOC',
    '  after = 2',
    'end',
    'def outside',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const nested = chunks.find((chunk) => chunk.content.includes('def nested'))
  const outside = chunks.find((chunk) => chunk.content.includes('def outside'))
  assert.equal(nested?.symbol, 'def nested')
  assert.equal(outside?.symbol, 'def outside')
})

test('chunkText: nested Ruby blocks in a for loop keep the method symbol until the loop ends', () => {
  const src = [
    'def method',
    '  for item in items do values.each do |value|',
    '    puts value',
    '  end',
    '  end',
    '  after_loop',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const afterLoop = chunks.find((chunk) => chunk.content.includes('after_loop'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(afterLoop?.symbol, 'def method')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby setter names are not locals that hide a heredoc', () => {
  const src = [
    'class Thing',
    '  def value=(x)',
    '    value <<TEXT',
    'end',
    'TEXT',
    '  end',
    '  def after',
    '    work',
    '  end',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const heredocEnd = chunks.find((chunk) => chunk.content.includes('TEXT\n  end'))
  const after = chunks.find((chunk) => chunk.content.includes('def after'))
  assert.equal(heredocEnd?.symbol, 'def value=(x)')
  assert.equal(after?.symbol, 'def after')
})

test('chunkText: TypeScript object return members after unions keep the body labeled', () => {
  const src = [
    'function f(): string | {',
    '  value: string',
    '}',
    '{',
    '  return { value: "ok" }',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return { value:'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside = 1'))
  assert.equal(body?.symbol, 'function f(): string | {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Scala match and for-do continuations retain the expression function', () => {
  const cases = [
    {
      lines: ['object Test {', '  def f = value match', '    case x => x', '  val after = 1', '}'],
      body: 'case x => x',
      symbol: 'def f = value match',
    },
    {
      lines: ['object Test {', '  def f = for x <- xs do', '    use(x)', '  val after = 1', '}'],
      body: 'use(x)',
      symbol: 'def f = for x <- xs do',
    },
  ] as const
  for (const { lines, body, symbol } of cases) {
    const chunks = chunkText(lines.join('\n'), languageForPath('a.scala'), { maxLines: 80 })
    const bodyChunk = chunks.find((chunk) => chunk.content.includes(body))
    const after = chunks.find((chunk) => chunk.content.includes('val after = 1'))
    assert.equal(bodyChunk?.symbol, symbol, body)
    assert.equal(after?.symbol, 'object Test {', body)
  }
})

test('chunkText: Ruby heredoc openers preserve surrounding hash braces', () => {
  const src = [
    'def f = { key: <<~DOC',
    '  value',
    'DOC',
    '}',
    'def after',
    '  1',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const close = chunks.find((chunk) => chunk.content.includes('DOC\n}'))
  const after = chunks.find((chunk) => chunk.content.includes('def after'))
  assert.equal(close?.symbol, 'def f = { key: <<~DOC')
  assert.equal(after?.symbol, 'def after')
})

test('chunkText: ambient TypeScript classes and interfaces are declaration symbols', () => {
  const src = [
    'declare class Foo {',
    '  run(): void',
    '}',
    'declare interface Bar {',
    '  run(): void',
    '}',
    'declare const outside: number',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const declaredClass = chunks.find((chunk) => chunk.content.includes('declare class Foo'))
  const declaredInterface = chunks.find((chunk) => chunk.content.includes('declare interface Bar'))
  assert.equal(declaredClass?.symbol, 'declare class Foo {')
  assert.equal(declaredInterface?.symbol, 'declare interface Bar {')
})

test('chunkText: Ruby command-call regexes can begin with whitespace', () => {
  const src = [
    'def f',
    '  puts / end/',
    '  work',
    'end',
    'def after',
    '  1',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('work'))
  const after = chunks.find((chunk) => chunk.content.includes('def after'))
  assert.equal(body?.symbol, 'def f')
  assert.equal(after?.symbol, 'def after')
})

test('chunkText: C# interpolated strings scan nested string literals inside expressions', () => {
  const src = [
    'class C {',
    '  string F() {',
    '    var s = $"{GetValue("}")}";',
    '    return s;',
    '  }',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.cs'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return s;'))
  assert.equal(body?.symbol, 'string F() {')
})

test('chunkText: TypeScript generic object constraints do not open function bodies', () => {
  const src = [
    'function f<T extends { value: string }>',
    '  (value: T): T {',
    '    return value',
    '  }',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside = 1'))
  assert.equal(body?.symbol, 'function f<T extends { value: string }>')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby bare parameters before parenthesized defaults stay local', () => {
  const src = [
    'def f word, value = build(1)',
    '  word <<item',
    'end',
    'def outside',
    '  1',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('def outside'))
  assert.equal(outside?.symbol, 'def outside')
})

test('chunkText: Ruby for-loop locals survive a nested block', () => {
  const src = [
    'def method',
    '  for item in items do values.each do |value| use(value) end; end',
    '  item <<DOC',
    'end',
    'def outside',
    '  1',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('def outside'))
  assert.equal(outside?.symbol, 'def outside')
})

test('chunkText: Ruby percent strings reset escaped-newline state at line boundaries', () => {
  const src = [
    'def f',
    '  text = %Q{foo' + '\\',
    '}',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: semicolon-separated Ruby conditionals do not end the method symbol', () => {
  const src = [
    'def f; if ready; work; end',
    '  after',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('after'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def f; if ready; work; end')
  assert.equal(outside?.symbol, '')
})

test('chunkText: multiline TypeScript conditional return types keep the body labeled', () => {
  const src = [
    'function choose<T>(value: T): T extends string',
    '  ? string',
    '  : number {',
    '  return value as any',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value as any'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside = 1'))
  assert.equal(body?.symbol, 'function choose<T>(value: T): T extends string')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby interpolation assignments stay in their original scope', () => {
  const src = [
    'DOC = 1',
    'def f',
    '  "#{value = 1}"; [].each do |item| end',
    '  puts value <<DOC',
    'end',
    'outside = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 2'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: negated Bash brace groups keep the enclosing function scope', () => {
  const src = [
    'function f() {',
    '  ! { :; }',
    '  # still in the function',
    '  echo still_in_f',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('echo still_in_f'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside=1'))
  assert.equal(body?.symbol, 'function f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: escaped apostrophes in Bash ANSI-C strings keep braces literal', () => {
  const src = [
    'function f() {',
    "  printf '%s' $'quote \\';} still quoted'",
    '  echo still_in_f',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('echo still_in_f'))
  assert.equal(body?.symbol, 'function f() {')
})

test('chunkText: braces inside Swift slash regexes keep the enclosing function scope', () => {
  const src = [
    'func f() {',
    '  let pattern = /[}]/',
    '  return pattern',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.swift'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return pattern'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))
  assert.equal(body?.symbol, 'func f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: comment-like text in JavaScript regexes preserves arrow continuations', () => {
  const src = [
    'const f = () => /\\/*/ +',
    '  value',
    'const after = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const operand = chunks.find((chunk) => chunk.content.includes('  value'))
  assert.equal(operand?.symbol, 'const f = () => /\\/*/ +')
})

test('chunkText: parenthesized JavaScript arrows end prior expression scopes', () => {
  const cases = ['(x) => x', 'async (x) => x'] as const
  for (const expression of cases) {
    const src = ['const f = () => 1', expression, 'const after = 2'].join('\n')
    const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
    const arrow = chunks.find((chunk) => chunk.content.includes(expression))
    assert.equal(arrow?.symbol, '', expression)
  }
})

test('chunkText: parameterless Ruby block locals do not suppress later heredocs', () => {
  const blockCases = [
    ['  items.each do', '  end'],
    ['  items.each {', '  }'],
  ] as const
  for (const [blockStart, blockEnd] of blockCases) {
    const src = [
      'def method',
      blockStart,
      '    value = 1',
      blockEnd,
      '  puts value <<DOC',
      'def nested',
      'DOC',
      'end',
      'outside = 1',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
    const heredoc = chunks.find((chunk) => chunk.content.includes('def nested'))
    assert.equal(heredoc?.symbol, 'def method', blockStart)
  }
})

test('chunkText: C++ directive continuations require a backslash directly before newline', () => {
  const src = [
    '#define VALUE 1 \\   ',
    'void f() {',
    '  return VALUE;',
    '}',
    'int outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.cpp'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return VALUE;'))
  const outside = chunks.find((chunk) => chunk.content.includes('int outside = 1;'))
  assert.equal(body?.symbol, 'void f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript property calls named if do not start a control condition', () => {
  const src = [
    'function f() {',
    '  const x = obj.if(x) / /}/.test(s)',
    '  return x',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return x'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside = 1'))
  assert.equal(body?.symbol, 'function f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: multiline Kotlin and Scala else branches keep expression function symbols', () => {
  const cases = [
    {
      path: 'a.kt',
      declaration: 'fun choose(x: Boolean) = if (x) "yes"',
      elseLine: 'else "no"',
    },
    {
      path: 'a.scala',
      declaration: 'def choose(x: Boolean) = if x then "yes"',
      elseLine: 'else "no"',
    },
  ] as const
  const symbols = cases.map(({ path, declaration, elseLine }) => {
    const src = [declaration, elseLine, 'val after = 1'].join('\n')
    const chunks = chunkText(src, languageForPath(path), { maxLines: 80 })
    const elseChunk = chunks.find((chunk) => chunk.content.includes(elseLine))
    return elseChunk?.symbol
  })
  assert.deepEqual(symbols, cases.map(({ declaration }) => declaration))
})

test('chunkText: TypeScript conditional object return branches stay in the signature', () => {
  const src = [
    'function f<T>(): T extends string',
    '  ? { value: string }',
    '  : number {',
    '  return {} as any',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return {} as any'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside = 1'))
  assert.equal(body?.symbol, 'function f<T>(): T extends string')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Python indentation expands tabs to eight-column stops', () => {
  const src = [
    'def outer():',
    '       \tdef inner():',
    '         return 1',
    '    after_inner()',
    'outside = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.py'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return 1'))
  assert.match(body?.symbol ?? '', /^\s*def inner\(\):$/)
})

test('chunkText: Ruby owner-qualified method parameters remain known locals', () => {
  const src = [
    'def Foo::bar(value)',
    '  value <<ITEM',
    '  def nested',
    '    work',
    '  end',
    'ITEM',
    '  finish',
    'end',
    'def after',
    '  1',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const nested = chunks.find((chunk) => chunk.content.includes('def nested'))
  const after = chunks.find((chunk) => chunk.content.includes('def after'))
  assert.equal(nested?.symbol, 'def nested')
  assert.equal(after?.symbol, 'def after')
})

test('chunkText: Ruby parallel-assignment locals keep following shifts out of heredoc state', () => {
  const src = [
    'def method',
    '  if condition',
    '    first, second, third = [1, 2, 3]',
    '    first <<ITEM',
    '    second <<ITEM',
    '    third <<ITEM',
    '    head, *tail = [4, 5]',
    '    head <<ITEM',
    '    tail <<ITEM',
    '  end',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: receiver-qualified Ruby endless methods with parameters end before following code', () => {
  const src = [
    'def obj.foo(value) = value',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('def obj.foo'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(method?.symbol, 'def obj.foo(value) = value')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby block locals end before a same-line heredoc opener', () => {
  const src = [
    'def outer',
    '  items.each do |item|',
    '    work',
    '  end; item <<DOC',
    '    end',
    'DOC',
    '  finish',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('finish'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def outer')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby lambda parameters keep shifts out of heredoc state', () => {
  const src = [
    'def method',
    '  ->(value) {',
    '    value <<DOC',
    '  }',
    'end',
    'DOC',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(outside?.symbol, '')
})

test('chunkText: inline-closed Ruby methods do not leave stale scopes', () => {
  const src = [
    'def f; end; value = 1',
    'def g',
    '  work',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('  work'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(method?.symbol, 'def g')
  assert.equal(outside?.symbol, '')
})

test('chunkText: assignments inside Ruby interpolation blocks stay scoped to the block', () => {
  const src = [
    'def method',
    '  "#{items.each { hidden = 1 }}"',
    '  hidden <<DOC',
    'end',
    'DOC',
    '  finish',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('finish'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'def method')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Bash if groups keep the enclosing function symbol', () => {
  const src = [
    'function f() {',
    '  if { :; }; then',
    '    echo still_in_f',
    '  fi',
    '  echo after_if',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('echo still_in_f'))
  const after = chunks.find((chunk) => chunk.content.includes('echo after_if'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside=1'))
  assert.equal(body?.symbol, 'function f() {')
  assert.equal(after?.symbol, 'function f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: PHP heredoc expression suffixes end the heredoc state', () => {
  const src = [
    '<?php',
    'function f() {',
    '  $text = <<<TXT',
    'body',
    'TXT . "suffix";',
    '  work();',
    '}',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.php'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('work();'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside();'))
  assert.equal(body?.symbol, 'function f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Ruby multiline endless-method assignments stay local', () => {
  const src = [
    'def value =',
    '  hidden = 1',
    'hidden <<DOC',
    'def nested',
    '  work',
    'end',
    'DOC',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const heredoc = chunks.find((chunk) => chunk.content.includes('hidden <<DOC'))
  const nested = chunks.find((chunk) => chunk.content.includes('def nested'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(heredoc?.symbol, '')
  assert.equal(nested?.symbol, '')
  assert.equal(outside?.symbol, '')
})

test('chunkText: C++ digraph directives do not keep function scopes open', () => {
  const src = [
    'void f() {',
    '  %:define OPEN {',
    '  work();',
    '}',
    'int outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.cpp'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('work();'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, 'void f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: prefixed C++ character literals do not keep function scopes open', () => {
  for (const literal of ["u8'a'", "U'1'"]) {
    const src = [
      'void f() {',
      `  auto c = ${literal};`,
      '}',
      'int outside = 1;',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.cpp'), { maxLines: 80 })
    const body = chunks.find((chunk) => chunk.content.includes(`auto c = ${literal}`))
    const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
    assert.equal(body?.symbol, 'void f() {', literal)
    assert.equal(outside?.symbol, '', literal)
  }
})

test('chunkText: TypeScript generic function-type constraints keep multiline bodies labeled', () => {
  const src = [
    'function f<T extends (x: string) => void>(value: T)',
    '{',
    '  return value',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside = 1'))
  assert.equal(body?.symbol, 'function f<T extends (x: string) => void>(value: T)')
  assert.equal(outside?.symbol, '')
})

test('chunkText: multiline Ruby endless-method parameters remain known in the body', () => {
  const src = [
    'def value(argument) =',
    '  argument <<DOC',
    'body',
    'DOC',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const shift = chunks.find((chunk) => chunk.content.includes('argument <<DOC'))
  const body = chunks.find((chunk) => chunk.content.includes('body'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(shift?.symbol, 'def value(argument) =')
  assert.equal(body?.symbol, '')
  assert.equal(outside?.symbol, '')
})

test('chunkText: C++ hexadecimal digit separators do not hide function closing braces', () => {
  const src = [
    "void f() { int n = 0xA'B; } char c = 'x';",
    'int outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.cpp'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('0xA'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(body?.symbol, "void f() { int n = 0xA'B; } char c = 'x';")
  assert.equal(outside?.symbol, '')
})

test('chunkText: PHP heredoc terminators allow plus-expression suffixes', () => {
  const src = [
    '<?php',
    'function f() {',
    '  $text = <<<TXT',
    'body',
    'TXT + $suffix;',
    '  work();',
    '}',
    'outside();',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.php'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('work();'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside();'))
  assert.equal(body?.symbol, 'function f() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: JavaScript comments do not classify control blocks as function expressions', () => {
  const src = [
    'function outer() {',
    '  if (ready) /* function */ {',
    '    first();',
    '  }',
    "  /}/.test('');",
    '  work();',
    '}',
    'const outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const regex = chunks.find((chunk) => chunk.content.includes("/}/.test('')"))
  const after = chunks.find((chunk) => chunk.content.includes('work();'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(regex?.symbol, 'function outer() {')
  assert.equal(after?.symbol, 'function outer() {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript inline generic function bodies use the formal parameter list', () => {
  const src = [
    'function f<T extends (x: string) => void>(value: T) {',
    '  return value',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return value'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside = 1'))
  assert.equal(body?.symbol, 'function f<T extends (x: string) => void>(value: T) {')
  assert.equal(outside?.symbol, '')
})

test('chunkText: sibling Ruby block parameters do not leak into earlier blocks', () => {
  const src = [
    'def f; items.each { foo <<ITEM }; items.each { |foo| work }; end',
    'def nested',
    '  work',
    'end',
    'ITEM',
    'def outside',
    '  work',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const nested = chunks.find((chunk) => chunk.content.includes('def nested'))
  const outside = chunks.find((chunk) => chunk.content.includes('def outside'))
  assert.equal(nested?.symbol, '')
  assert.equal(outside?.symbol, 'def outside')
})

test('chunkText: Ruby lambda default parameters do not leak into the enclosing method', () => {
  const src = [
    'def f',
    '  ->(value = build(1)) { work }',
    '  value <<DOC',
    'def nested',
    '  work',
    'end',
    'DOC',
    'end',
    'def outside',
    '  work',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const nested = chunks.find((chunk) => chunk.content.includes('def nested'))
  const outside = chunks.find((chunk) => chunk.content.includes('def outside'))
  assert.equal(nested?.symbol, 'def f')
  assert.equal(outside?.symbol, 'def outside')
})

test('chunkText: endless Ruby parameters stay local across continued body lines', () => {
  const src = [
    'def f(value) = 1 +',
    '  value <<ITEM',
    'work',
    'ITEM',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const work = chunks.find((chunk) => chunk.content.includes('work'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(work?.symbol, '')
  assert.equal(outside?.symbol, '')
})

test('chunkText: multiline Ruby endless-method signatures end without an end keyword', () => {
  const src = [
    'def f(',
    '  value) = value',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const method = chunks.find((chunk) => chunk.content.includes('value) = value'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))
  assert.equal(method?.symbol, 'def f(')
  assert.equal(outside?.symbol, '')
})

test('chunkText: round14 regression: C++ %: directives preserve C-linkage scope tracking', () => {
  const src = [
    'extern "C" {',
    '%:define CLOSE_LINKAGE }',
    'int inside_api;',
    '}',
    'int outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.cpp'), { maxLines: 80 })
  assert.ok(chunks.some((chunk) => chunk.symbol === 'int inside_api;'), `got ${chunks.map((chunk) => chunk.symbol)}`)
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside = 1'))?.symbol, '')
})

test('chunkText: round14 regression: C++ digit separators split by a line splice keep braces visible', () => {
  const src = [
    'void f() {',
    "  auto value = 0xA\\",
    "'B;",
    '}',
    'int outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.cpp'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('auto value'))
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside = 1'))?.symbol, '')
  assert.equal(body?.symbol, 'void f() {')
})

test('chunkText: round14 regression: same-line JavaScript strings do not misclassify following control blocks', () => {
  const src = [
    'function outer() {',
    '  const marker = "function"; if (ready) {',
    '    work();',
    '  }',
    '  /}/.test(value);',
    '  after();',
    '}',
    'const outside = 1;',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('after();'))?.symbol, 'function outer() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside = 1'))?.symbol, '')
})

test('chunkText: round14 regression: Ruby %Q interpolation assignments keep later shifts out of heredoc state', () => {
  const src = [
    'def f',
    '  text = %Q(#{value = 1})',
    '  value <<DOC',
    '  def nested',
    '    work',
    '  end',
    'DOC',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('def nested'))?.symbol, 'def nested')
})

test('chunkText: round14 regression: Ruby heredoc interpolation assignments keep later shifts out of heredoc state', () => {
  const src = [
    'def f',
    '  text = <<~OUTER',
    '    #{value = 1}',
    '  OUTER',
    '  value <<DOC',
    '  def nested',
    '    work',
    '  end',
    'DOC',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('def nested'))?.symbol, 'def nested')
})

test('chunkText: round14 regression: Ruby regex braces do not close string interpolation', () => {
  const src = [
    'def f',
    '  text = "#{/}/.match?(input); value = 1}"',
    '  value <<DOC',
    '  def nested',
    '    work',
    '  end',
    'DOC',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('def nested'))?.symbol, 'def nested')
})

test('chunkText: round14 regression: Ruby division before a regex containing end keeps the method open', () => {
  const src = [
    'def f(value)',
    '  value / /end/',
    '  work',
    'end',
    'def outside',
    '  work',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('  work\nend') && !chunk.content.includes('outside'))?.symbol, 'def f(value)')
  assert.equal(chunks.find((chunk) => chunk.content.includes('def outside'))?.symbol, 'def outside')
})

test('chunkText: round14 regression: Ruby regex escape state resets after an escaped newline', () => {
  const src = [
    'def f',
    '  pattern = /foo\\',
    '/; work',
    'end',
    'def outside',
    '  work',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('/; work'))?.symbol, 'def f')
  assert.equal(chunks.find((chunk) => chunk.content.includes('def outside'))?.symbol, 'def outside')
})

test('chunkText: round14 regression: Ruby block parameters do not leak to sibling blocks', () => {
  const src = [
    'def f; items.each { |value| work }; items.each { value <<DOC }; end',
    'def nested',
    '  work',
    'end',
    'DOC',
    'end',
    'def outside',
    '  work',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('def nested'))?.symbol, '')
  assert.equal(chunks.find((chunk) => chunk.content.includes('def outside'))?.symbol, 'def outside')
})

test('chunkText: round14 regression: assignments in parameterless Ruby lambdas stay lambda-local', () => {
  const src = [
    'def f',
    '  -> { value = 1 }',
    '  value <<DOC',
    '  def nested',
    '    work',
    '  end',
    'DOC',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('def nested'))?.symbol, 'def f')
})

test('chunkText: round14 regression: continued bare Ruby method parameters remain local', () => {
  const src = [
    'def f first,',
    '  second',
    '  second <<DOC',
    '  def nested',
    '    work',
    '  end',
    'DOC',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('def nested'))?.symbol, 'def nested')
})

test('chunkText: round14 regression: continued Ruby endless-method assignments stay local', () => {
  const src = [
    'def f = (local = 1) +',
    '  local <<DOC',
    '  def nested',
    '    work',
    '  end',
    'DOC',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('def nested'))?.symbol, 'def nested')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside = 1'))?.symbol, '')
})

test('chunkText: round14 regression: multiline Ruby endless signatures label their continuation body', () => {
  const src = [
    'def f(',
    '  value',
    ') =',
    '  value + 1',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('value + 1'))?.symbol, 'def f(')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside = 1'))?.symbol, '')
})

test('chunkText: round14 regression: Bash mixed-quoted heredoc delimiters use quote removal', () => {
  const src = [
    'f() {',
    '  cat <<E"OF"',
    '  } literal heredoc text',
    'EOF',
    '  work',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside()'))?.symbol, '')
})

test('chunkText: round14 regression: Rust raw C strings mask quotes and braces', () => {
  const src = [
    'fn f() {',
    '  let text = cr#"quote " } still literal"#;',
    '  work();',
    '}',
    'fn outside() {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rs'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('work();'))?.symbol, 'fn f() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('fn outside'))?.symbol, 'fn outside() {}')
})

test('chunkText: round14 regression: Kotlin multiline Map return types stay attached to the body', () => {
  const src = [
    'fun f(): Map<',
    '  String,',
    '  Int',
    '> {',
    '  work()',
    '}',
    'val outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('work()'))?.symbol, 'fun f(): Map<')
  assert.equal(chunks.find((chunk) => chunk.content.includes('val outside = 1'))?.symbol, '')
})

test('chunkText: round14 regression: Scala multiline Map return types stay attached to the body', () => {
  const src = [
    'def f: Map[',
    '  String,',
    '  Int',
    '] = {',
    '  work()',
    '}',
    'val outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('work()'))?.symbol, 'def f: Map[')
  assert.equal(chunks.find((chunk) => chunk.content.includes('val outside = 1'))?.symbol, '')
})

test('chunkText: JavaScript template text does not misclassify a control block', () => {
  const src = [
    'function outer() {',
    '  const text = `function`; if (true) {}',
    "  /}/.test('')",
    '  work()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('work()'))?.symbol, 'function outer() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside()'))?.symbol, '')
})

test('chunkText: JavaScript regex text does not misclassify a control block', () => {
  const src = [
    'function outer() {',
    '  const pattern = /function/; if (true) {}',
    "  /}/.test('')",
    '  work()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('work()'))?.symbol, 'function outer() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside()'))?.symbol, '')
})

test('chunkText: Ruby assignments inside %s literals do not affect heredoc detection', () => {
  const src = [
    'def f',
    '  symbol = %s{#{value = 1}}',
    '  value <<DOC',
    'def fake',
    'DOC',
    '  after = 1',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('def fake'))?.symbol, 'def f')
  assert.equal(chunks.find((chunk) => chunk.content.includes('after = 1'))?.symbol, 'def f')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside = 1'))?.symbol, '')
})

test('chunkText: multiline Bash arithmetic shifts do not start heredocs', () => {
  const src = [
    'function f {',
    '  (( result =',
    '     1 << SHIFT',
    '  ))',
    '  after',
    '}',
    'outside',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('after'))?.symbol, 'function f {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside'))?.symbol, '')
})

test('chunkText: Scala symbolic methods retain multiline generic return types', () => {
  const src = [
    'def +(other: Int): Map[',
    '  String,',
    '  Int',
    '] =',
    '  Map("x" -> other)',
    'def peer = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('Map("x"'))?.symbol, 'def +(other: Int): Map[')
  assert.equal(chunks.find((chunk) => chunk.content.includes('def peer'))?.symbol, 'def peer = 1')
})

test('chunkText: Scala backticked methods retain multiline generic return types', () => {
  const src = [
    'def `plus`(other: Int): Map[',
    '  String,',
    '  Int',
    '] =',
    '  Map("x" -> other)',
    'def peer = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('Map("x"'))?.symbol, 'def `plus`(other: Int): Map[')
  assert.equal(chunks.find((chunk) => chunk.content.includes('def peer'))?.symbol, 'def peer = 1')
})

test('chunkText: code after a Scala block-comment close keeps its indentation scope', () => {
  const src = [
    'object O:',
    '  def local =',
    '    1 +',
    '      2',
    '    /* comment',
    '    */work()',
    '    after()',
    '  def peer = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  assert.equal(chunks.find((chunk) => chunk.content.includes('work()'))?.symbol, 'def local =')
  assert.equal(chunks.find((chunk) => chunk.content.includes('after()'))?.symbol, 'def local =')
  assert.equal(chunks.find((chunk) => chunk.content.includes('def peer'))?.symbol, 'def peer = 1')
})

test('chunkText: Unicode Kotlin annotations belong to the following declaration', () => {
  const src = [
    'fun before() = if (ready)',
    '  1',
    '@Δοκιμή',
    'fun after() {}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const annotation = chunks.find((chunk) => chunk.content.includes('@Δοκιμή'))
  const declaration = chunks.find((chunk) => chunk.content.includes('fun after()'))

  assert.equal(annotation?.symbol, 'fun after() {}')
  assert.equal(declaration?.symbol, 'fun after() {}')
})

test('chunkText: Unicode Ruby locals keep following shifts out of heredoc state', () => {
  const src = [
    'def f',
    '  café = 1',
    '  café <<item',
    '  hidden = 1',
    'end',
    'def after',
    '  visible = 2',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('def after'))

  assert.equal(after?.symbol, 'def after')
})

test('chunkText: Scala quoted defaults preserve multiline generic return type symbols', () => {
  const src = [
    'def f[T](x: T = ")"): Map[',
    '  String,',
    '  List[T]',
    '] =',
    '  x',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('  x'))

  assert.equal(body?.symbol, 'def f[T](x: T = ")"): Map[')
})

test('chunkText: Ruby regex keywords inside interpolation do not expose heredoc payload as code', () => {
  const src = [
    'def outer',
    '  value = "#{items.each do',
    '    pattern = /end/',
    '    hidden = 1',
    '  end}"',
    '  hidden <<DOC',
    '  def nested; end',
    'DOC',
    '  visible = 2',
    'end',
    'def after; end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const heredocPayload = chunks.find((chunk) => chunk.content.includes('def nested; end'))

  assert.equal(heredocPayload?.symbol, 'def outer')
})

test('chunkText: standalone Ruby numeric shifts do not open heredocs', () => {
  const src = [
    'def f',
    '  1 <<item',
    '  work',
    'end',
    'def after',
    '  visible = 1',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('def after'))

  assert.equal(after?.symbol, 'def after')
})

test('chunkText: object literals in JavaScript template interpolations preserve function scope', () => {
  const src = [
    'function f() {',
    '  const s = `${{a: 1} / "x/y"}`;',
    '}',
    'const after = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('const after = 1'))

  assert.equal(after?.symbol, '')
})

test('chunkText: Scala multiline refinement types keep the method body labeled', () => {
  const src = [
    'def f: AnyRef {',
    '  type T = Int',
    '} =',
    '  work()',
    'def after = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('work()'))

  assert.equal(body?.symbol, 'def f: AnyRef {')
})

test('chunkText: TypeScript quoted brace return types keep split function bodies labeled', () => {
  const src = [
    'function f(): "}" {',
    '  return "}"',
    '}',
    'const after = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return "}"'))

  assert.equal(body?.symbol, 'function f(): "}" {')
})

test('chunkText: Unicode JavaScript assignments end prior arrow expression symbols', () => {
  const src = [
    'const π = 0',
    'const f = () => 1',
    'π = 2',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const assignment = chunks.find((chunk) => chunk.content.includes('π = 2'))

  assert.equal(assignment?.symbol, '')
})

test('chunkText: Kotlin function-type bounds do not treat parameter defaults as expression bodies', () => {
  const src = [
    'fun <T : (String) -> Unit> f(value: Int = 1)',
    '{',
    '  work()',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('work()'))

  assert.equal(body?.symbol, 'fun <T : (String) -> Unit> f(value: Int = 1)')
})

test('chunkText: conditional TypeScript object return branches keep a split function body labeled', () => {
  const src = [
    'function f<T>(): T extends string',
    '  ? { a: string }',
    '  : { b: number }',
    '{',
    '  return {} as any',
    '}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const body = chunks.find((chunk) => chunk.content.includes('return {} as any'))
  const outside = chunks.find((chunk) => chunk.content.includes('const outside = 1'))

  assert.equal(body?.symbol, 'function f<T>(): T extends string')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Unicode Ruby parameters keep following shifts out of heredoc state', () => {
  const src = [
    'def f(π)',
    '  π <<ITEM',
    'end',
    'ITEM',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))

  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript decorators end prior arrow expression scopes', () => {
  const src = [
    'const f = () => 1',
    '@dec',
    'class C {}',
    'const outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const decorator = chunks.find((chunk) => chunk.content.includes('@dec'))

  assert.equal(decorator?.symbol, '')
})

test('chunkText: escaped Ruby heredoc interpolation markers do not create locals', () => {
  const src = [
    'def outer',
    '  text = <<FIRST',
    '  \\#{value = 1}',
    'FIRST',
    '  value <<DOC',
    '  end',
    'DOC',
    '  after = 1',
    'end',
    'def next_method',
    '  1',
    'end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const after = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const nextMethod = chunks.find((chunk) => chunk.content.includes('def next_method'))

  assert.equal(after?.symbol, 'def outer')
  assert.equal(nextMethod?.symbol, 'def next_method')
})

test('chunkText: Scala string literal brackets do not keep generic return types pending', () => {
  const src = [
    'def f: Map["[", Int] = value',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('def f:'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside()'))

  assert.equal(declaration?.symbol, 'def f: Map["[", Int] = value')
  assert.equal(outside?.symbol, '')
})

test('chunkText: Scala generic calls end prior local expression method scopes', () => {
  const src = [
    'def local =',
    '  1 +',
    '  2',
    'consume[String]()',
    'def after = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })
  const call = chunks.find((chunk) => chunk.content.includes('consume[String]()'))
  const after = chunks.find((chunk) => chunk.content.includes('def after = 2'))

  assert.equal(call?.symbol, '')
  assert.equal(after?.symbol, 'def after = 2')
})

test('chunkText: Unicode JavaScript calls end prior expression-bodied declaration scopes', () => {
  const src = [
    'const f = () => 1',
    'π()',
    'function after() {',
    '  work()',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const call = chunks.find((chunk) => chunk.content.includes('π()'))
  const after = chunks.find((chunk) => chunk.content.includes('function after()'))

  assert.equal(call?.symbol, '')
  assert.equal(after?.symbol, 'function after() {')
})

test('chunkText: same-line Ruby class methods release locals before class heredocs', () => {
  const src = [
    'class C; def f; item = 1; end',
    'item <<DOC',
    'end',
    'DOC',
    'member = 2',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const classHeader = chunks.find((chunk) => chunk.content.includes('class C;'))
  const member = chunks.find((chunk) => chunk.content.includes('member = 2'))
  const outside = chunks.find((chunk) => chunk.content.includes('outside = 1'))

  assert.ok(classHeader)
  assert.equal(classHeader.symbol, 'class C; def f; item = 1; end')
  assert.ok(member)
  assert.equal(member!.symbol, classHeader.symbol)
  assert.equal(outside?.symbol, '')
})

test('chunkText: TypeScript using declarations end prior expression scopes', () => {
  const src = [
    'const f = () => 1',
    'using resource = acquire()',
    'const after = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })
  const declaration = chunks.find((chunk) => chunk.content.includes('using resource'))

  assert.equal(declaration?.symbol, '')
})

test('chunkText: parenthesized Bash heredocs stop before later function code', () => {
  const src = [
    'function f() {',
    '  (cat <<EOF)',
    '  } literal heredoc body',
    'EOF',
    '  echo still_in_f',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('echo still_in_f'))?.symbol, 'function f() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside=1'))?.symbol, '')
})

test('chunkText: nested Bash command substitutions keep parameter-expansion braces balanced', () => {
  const src = [
    'function f() {',
    '  value=\${value:-$( { echo "\${fallback}"; } )}',
    '  echo still_in_f',
    '}',
    'outside=1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('echo still_in_f'))?.symbol, 'function f() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside=1'))?.symbol, '')
})

test('chunkText: Unicode Ruby endless methods do not leave an extra method scope', () => {
  const src = [
    'class C',
    '  def π = 1',
    '  def next',
    '    work',
    '  end',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const nextMethod = chunks.find((chunk) => chunk.content.includes('def next'))

  assert.equal(nextMethod?.symbol, 'def next')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside = 1'))?.symbol, '')
})

test('chunkText: Unicode Scala methods retain split generic return types', () => {
  const src = [
    'def λ: Map[',
    '  String,',
    '  Int',
    '] =',
    '  Map("x" -> 1)',
    'def peer = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('Map("x"'))?.symbol, 'def λ: Map[')
  assert.equal(chunks.find((chunk) => chunk.content.includes('def peer'))?.symbol, 'def peer = 1')
})

test('chunkText: Unicode TypeScript functions retain multiline object return bodies', () => {
  const src = [
    'function π(): {',
    '  value: string',
    '} {',
    '  return { value: "ok" }',
    '}',
    'const after = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.ts'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('return {'))?.symbol, 'function π(): {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('const after = 1'))?.symbol, '')
})

test('chunkText: equals signs in Kotlin comments do not misclassify brace-bodied functions', () => {
  const src = [
    'fun f(value: Int = 1) // =',
    '{',
    '  use(value)',
    '}',
    'val after = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })

  assert.ok(chunks.find((chunk) => chunk.content.includes('use(value)'))?.symbol?.startsWith('fun f(value: Int = 1)'))
  assert.equal(chunks.find((chunk) => chunk.content.includes('val after = 2'))?.symbol, '')
})

test('chunkText: Unicode Ruby method names preserve parenthesized and bare parameter locals', () => {
  for (const signature of ['def café value', 'def café(value)']) {
    const src = [
      'class C',
      '  ' + signature,
      '    value <<DOC',
      '  end',
      'end',
      'outside = 1',
    ].join('\n')
    const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })

    assert.ok(chunks.find((chunk) => chunk.content.includes('value <<DOC'))?.symbol?.startsWith('def café'))
    assert.equal(chunks.find((chunk) => chunk.content.includes('outside = 1'))?.symbol, '')
  }
})

test('chunkText: round29 regression: decorated Scala block-comment closers preserve indentation', () => {
  const src = [
    'def outer =',
    '  work()',
    '  /* block comment',
    '    * note */val local = 1',
    '  local',
    'val peer = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('val local = 1'))?.symbol, 'def outer =')
  assert.equal(chunks.find((chunk) => chunk.content.includes('val peer = 2'))?.symbol, '')
})

test('chunkText: round29 regression: Bash continued heredoc delimiters match after line joining', () => {
  const src = [
    'function outer() {',
    '  cat <<EOF\\',
    'BAR',
    '  } literal heredoc text',
    'EOFBAR',
    '  work',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('literal heredoc text'))?.symbol, 'function outer() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside()'))?.symbol, '')
})

test('chunkText: round29 regression: Bash coproc groups retain both brace boundaries', () => {
  const src = [
    'function outer() {',
    '  coproc {',
    '    work',
    '  }',
    '  stillInside',
    '}',
    'outside',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('stillInside'))?.symbol, 'function outer() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside'))?.symbol, '')
})

test('chunkText: round29 regression: Kotlin function-type receivers skip their own parameter parens', () => {
  const src = [
    'fun ((Int) -> Unit).invokeTwice(times: Int = 2)',
    '{',
    '  work()',
    '}',
    'val after = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('work()'))?.symbol, 'fun ((Int) -> Unit).invokeTwice(times: Int = 2)')
  assert.equal(chunks.find((chunk) => chunk.content.includes('val after = 1'))?.symbol, '')
})

test('chunkText: round29 regression: standalone JavaScript arrows accept Unicode parameters', () => {
  const src = [
    'const previous = () => 1',
    'π => work()',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('π => work()'))?.symbol, '')
})

test('chunkText: round29 regression: Ruby continued for headers count one opener', () => {
  const src = [
    'def outer',
    '  for item in items \\',
    '    do',
    '      work(item)',
    '    end',
    'end',
    'after = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('work(item)'))?.symbol, 'def outer')
  assert.equal(chunks.find((chunk) => chunk.content.includes('after = 1'))?.symbol, '')
})

test('chunkText: review regression: named Bash coproc groups retain the enclosing function scope', () => {
  const src = [
    'function outer() {',
    '  coproc worker {',
    '    work',
    '  }',
    '  stillInside',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 80 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('stillInside'))?.symbol, 'function outer() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside()'))?.symbol, '')
})

test('chunkText: review regression: quoted Bash heredoc delimiters continue across lines', () => {
  const src = [
    'function outer() {',
    '  cat <<"EOF\\',
    'BAR"',
    '  } literal heredoc text',
    'EOFBAR',
    '  function inner() {',
    '    work',
    '  }',
    '  after',
    '}',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.sh'), { maxLines: 5 })

  assert.equal(chunks.find((chunk) => chunk.content.includes('literal heredoc text'))?.symbol, 'function outer() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('after'))?.symbol, 'function outer() {')
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside()'))?.symbol, '')
})

test('chunkText: review regression: nested JavaScript arrow parameters start peer expressions', () => {
  const src = [
    'const previous = () => 1',
    '({ value = make() }) => work()',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const previous = chunks.find((chunk) => chunk.content.includes('const previous'))

  assert.equal(previous?.symbol, 'const previous = () => 1')
  assert.equal(chunks.find((chunk) => chunk.content.includes('({ value = make() })'))?.symbol, '')
})

test('chunkText: review regression: Unicode JavaScript member expressions end prior symbols', () => {
  const src = [
    'const previous = () => 1',
    'π.ω',
    'outside()',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.js'), { maxLines: 80 })
  const previous = chunks.find((chunk) => chunk.content.includes('const previous'))

  assert.equal(previous?.symbol, 'const previous = () => 1')
  assert.equal(chunks.find((chunk) => chunk.content.includes('π.ω'))?.symbol, '')
})

test('chunkText: review regression: Unicode Kotlin calls end prior expression symbols', () => {
  const src = [
    'fun outer() {',
    '  fun local() = 1 +',
    '    2',
    '  π()',
    '}',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.kt'), { maxLines: 80 })
  const localBody = chunks.find((chunk) => chunk.content.includes('    2'))

  assert.equal(localBody?.symbol, 'fun local() = 1 +')
  assert.equal(chunks.find((chunk) => chunk.content.includes('π()'))?.symbol, 'fun outer() {')
})

test('chunkText: review regression: completed Ruby block locals do not hide later heredocs', () => {
  const src = [
    'def outer',
    '  items.each { hidden = 1 }; hidden <<DOC',
    '  def nested; end',
    'DOC',
    '  after = 1',
    'end',
    'def next_method; end',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const payload = chunks.find((chunk) => chunk.content.includes('def nested; end'))
  const after = chunks.find((chunk) => chunk.content.includes('after = 1'))
  const nextMethod = chunks.find((chunk) => chunk.content.includes('def next_method; end'))

  assert.equal(payload?.symbol, 'def outer')
  assert.equal(after?.symbol, 'def outer')
  assert.equal(nextMethod?.symbol, 'def next_method; end')
})

test('chunkText: review regression: same-line Ruby class methods isolate outer locals', () => {
  const src = [
    'outer = 1',
    'class C; def f; end',
    'outer <<DOC',
    'def nested; end',
    'DOC',
    'member = 2',
    'end',
    'outside = 1',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.rb'), { maxLines: 80 })
  const classHeader = chunks.find((chunk) => chunk.content.includes('class C;'))
  const payload = chunks.find((chunk) => chunk.content.includes('def nested; end'))
  const member = chunks.find((chunk) => chunk.content.includes('member = 2'))

  assert.ok(classHeader)
  assert.equal(classHeader.symbol, 'class C; def f; end')
  assert.ok(payload)
  assert.ok(member)
  assert.equal(payload!.symbol, classHeader.symbol)
  assert.equal(member!.symbol, classHeader.symbol)
  assert.equal(chunks.find((chunk) => chunk.content.includes('outside = 1'))?.symbol, '')
})

test('chunkText: decimal JavaScript and TypeScript literals end prior expression symbols', () => {
  for (const extension of ['js', 'ts']) {
    for (const literal of ['42.5', '.5']) {
      const src = ['const f = () => 1', literal, 'outside()'].join('\n')
      const chunks = chunkText(src, languageForPath(`a.${extension}`), { maxLines: 1 })
      const functionBody = chunks.find((chunk) => chunk.content === 'const f = () => 1')
      const expression = chunks.find((chunk) => chunk.content === literal)

      assert.equal(functionBody?.symbol, 'const f = () => 1', `${extension}: ${literal}`)
      assert.ok(expression, `${extension}: ${literal}`)
      assert.equal(expression!.symbol, '', `${extension}: ${literal}`)
    }
  }
})

test('chunkText: Scala triple-quoted defaults preserve expression-bodied method boundaries', () => {
  const src = [
    'def f(value: String = """a " b""") = 1',
    'work()',
    'def after = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 1 })
  const declaration = chunks.find((chunk) => chunk.content.includes('def f('))
  const call = chunks.find((chunk) => chunk.content === 'work()')

  assert.ok(declaration)
  assert.equal(declaration!.symbol, 'def f(value: String = """a " b""") = 1')
  assert.ok(call)
  assert.equal(call!.symbol, '')
})

test('chunkText: Unicode Scala calls end prior expression-bodied method symbols', () => {
  const src = [
    'def local =',
    '  1 +',
    '  2',
    'π()',
    'def after = 2',
  ].join('\n')
  const chunks = chunkText(src, languageForPath('a.scala'), { maxLines: 1 })
  const call = chunks.find((chunk) => chunk.content === 'π()')
  const after = chunks.find((chunk) => chunk.content === 'def after = 2')

  assert.ok(call)
  assert.equal(call!.symbol, '')
  assert.ok(after)
  assert.equal(after!.symbol, 'def after = 2')
})

test('chunkText: export declare TypeScript declarations end prior expression scopes', () => {
  const declaration = 'export declare const value: number'
  const chunks = chunkText(
    ['const f = () => 1', declaration].join('\n'),
    languageForPath('a.ts'),
    { maxLines: 1 },
  )
  const previous = chunks.find((chunk) => chunk.content === 'const f = () => 1')
  const ambient = chunks.find((chunk) => chunk.content === declaration)

  assert.equal(previous?.symbol, 'const f = () => 1')
  assert.ok(ambient)
  assert.equal(ambient!.symbol, '')
})

test('chunkText: ambient TypeScript type and enum declarations receive symbols', () => {
  for (const declaration of ['declare type T = string', 'declare enum E { A }']) {
    const chunks = chunkText(
      ['const before = () => 1', declaration, 'const after = 2'].join('\n'),
      languageForPath('a.ts'),
      { maxLines: 1 },
    )
    const declared = chunks.find((chunk) => chunk.content === declaration)
    const after = chunks.find((chunk) => chunk.content === 'const after = 2')

    assert.ok(declared, declaration)
    assert.equal(declared!.symbol, declaration)
    assert.ok(after, declaration)
    assert.equal(after!.symbol, '', declaration)
  }
})

test('chunkText: ambient TypeScript functions accept Unicode identifiers', () => {
  const declaration = 'declare function π(): void;'
  const chunks = chunkText(
    [declaration, 'const after = 1'].join('\n'),
    languageForPath('a.ts'),
    { maxLines: 1 },
  )
  const declared = chunks.find((chunk) => chunk.content === declaration)
  const after = chunks.find((chunk) => chunk.content === 'const after = 1')

  assert.ok(declared)
  assert.equal(declared!.symbol, declaration)
  assert.ok(after)
  assert.equal(after!.symbol, '')
})

test('chunkText: bodyless Scala case classes do not label following declarations', () => {
  const declaration = 'case class Box(value: Int)'
  const chunks = chunkText(
    [declaration, 'val outside = 1'].join('\n'),
    languageForPath('a.scala'),
    { maxLines: 1 },
  )
  const header = chunks.find((chunk) => chunk.content === declaration)
  const outside = chunks.find((chunk) => chunk.content === 'val outside = 1')

  assert.ok(header)
  assert.equal(header!.symbol, declaration)
  assert.ok(outside)
  assert.equal(outside!.symbol, '')
})

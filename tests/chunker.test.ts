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

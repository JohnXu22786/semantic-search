/**
 * Fragment construction from a single source file.
 *
 * Strategy (symbol-aware with graceful fallback to plain-text blocks):
 *  1. Normalize line endings.
 *  2. Detect symbol boundaries via the language table; a boundary line opens a
 *     new symbol whose body follows.
 *  3. Walk lines and emit chunks, starting a new chunk at each symbol boundary
 *     OR when the running chunk exceeds `maxLines` (preferring a nearby blank
 *     line as the cut point so semantic units stay intact; if none exists, cut
 *     at exactly `maxLines`).
 * Each chunk records its 1-based start/end lines, the nearest enclosing symbol
 * header, its raw text, and a one-line summary.
 */

import type { LanguageDef } from './languages.ts'
import { collapseWhitespace, matchSymbol } from './languages.ts'

const SPLIT_NAMESPACE_HEADER_RE = /^\s*(?:inline\s+)?namespace(?:\s*\[\[[^\]]*\]\])*(?:\s+[\w:]+)?\s*$/
const CPP_CLASS_MEMBER_TYPE_RE = /^(?:(?:const|volatile|unsigned|signed|short|long|typename)\s+)*[A-Za-z_]\w*(?:::\w+)*(?:\s*<[^;{}]+>)?(?:\s+(?:const|volatile))?(?:\s*[*&]+(?:\s*(?:const|volatile))?)?\s*$/
const RUBY_LITERAL_MARKER = '\u0000'

export interface ChunkCandidate {
  startLine: number
  endLine: number
  content: string
  symbol: string
  summary: string
}

export interface ChunkOptions {
  /** Maximum source lines per chunk (default 80). */
  maxLines: number
}

/** True for lines that make a clean cut point (blank or closing brace). */
function isBlankish(line: string): boolean {
  const t = line.trim()
  return t.length === 0 || t === '{' || t === '}' || t === ';'
}

function isCommentLine(line: string, lang: LanguageDef | null, initialBlockCommentDepth = 0): boolean {
  if (!lang) return false
  const t = skipLeadingBlockComments(line, lang, initialBlockCommentDepth)
  if (t.length === 0) return line.trim().length > 0
  for (const prefix of lang.commentPrefixes) {
    if (t.startsWith(prefix)) return true
  }
  return false
}

function isKotlinAnnotationLine(line: string): boolean {
  return /^@[_\p{ID_Start}][_\p{ID_Continue}]*(?:\.[_\p{ID_Start}][_\p{ID_Continue}]*)*(?::[_\p{ID_Start}][_\p{ID_Continue}]*(?:\.[_\p{ID_Start}][_\p{ID_Continue}]*)*)?(?=\s|\(|$)/u.test(line.trimStart())
}

function nextCodeLineAfterComments(
  lines: readonly string[],
  start: number,
  lang: LanguageDef,
  initialBlockCommentDepth = 0,
  cache?: Map<number, { code: string; indent: number } | null>,
): { code: string; indent: number } | null {
  if (cache?.has(start)) return cache.get(start) ?? null
  let blockCommentDepth = initialBlockCommentDepth
  const scannedLines: number[] = []
  for (let lineIndex = start; lineIndex < lines.length; lineIndex++) {
    if (cache?.has(lineIndex)) {
      const cached = cache.get(lineIndex) ?? null
      for (const scannedLine of scannedLines) cache?.set(scannedLine, cached)
      return cached
    }
    scannedLines.push(lineIndex)
    const line = lines[lineIndex]!
    let cursor = 0
    let indent = 0
    const leadingWhitespace = line.match(/^[ \t]*/)?.[0] ?? ''
    const leadingCommentIndent = blockCommentDepth > 0
      ? addIndentColumns(0, leadingWhitespace, lang.name === 'python' ? 8 : 4)
      : 0
    while (cursor < line.length) {
      if (blockCommentDepth === 0) {
        const whitespaceStart = cursor
        while (cursor < line.length && /\s/.test(line[cursor]!)) cursor++
        indent = addIndentColumns(indent, line.slice(whitespaceStart, cursor), lang.name === 'python' ? 8 : 4)
      }
      if (cursor === line.length) break
      if (blockCommentDepth > 0) {
        if (supportsNestedBlockComments(lang) && line.startsWith('/*', cursor)) {
          blockCommentDepth++
          cursor += 2
        } else if (line.startsWith('*/', cursor)) {
          blockCommentDepth--
          cursor += 2
          if (blockCommentDepth === 0 && leadingCommentIndent > 0) indent = leadingCommentIndent
        } else {
          cursor++
        }
      } else if (lang.commentPrefixes.includes('/*') && line.startsWith('/*', cursor)) {
        blockCommentDepth = 1
        cursor += 2
      } else if (lang.commentPrefixes.some((prefix) => prefix !== '/*' && prefix !== '*' && line.startsWith(prefix, cursor))) {
        break
      } else {
        const result = {
          code: line.slice(cursor),
          indent,
        }
        for (const scannedLine of scannedLines) cache?.set(scannedLine, result)
        return result
      }
    }
  }
  for (const scannedLine of scannedLines) cache?.set(scannedLine, null)
  return null
}

function skipLeadingBlockComments(line: string, lang: LanguageDef | null, initialDepth = 0): string {
  let code = line.trimStart()
  let depth = initialDepth
  while (depth > 0 || (lang?.commentPrefixes.includes('/*') && code.startsWith('/*'))) {
    if (depth === 0) {
      depth = 1
      code = code.slice(2)
    }
    let i = 0
    for (; i < code.length && depth > 0; i++) {
      if (supportsNestedBlockComments(lang) && code.startsWith('/*', i)) {
        depth++
        i++
      } else if (code.startsWith('*/', i)) {
        depth--
        i++
      }
    }
    if (depth > 0) return ''
    code = code.slice(i).trimStart()
  }
  while (code.startsWith('*/')) code = code.slice(2).trimStart()
  return code
}

function cLinkageOpenBraces(structuralLine: string, linkageLine: string, pendingExternKeyword = false): number[] {
  const openBraces: number[] = []
  let segmentStart = 0
  for (let i = 0; i < structuralLine.length; i++) {
    const char = structuralLine[i]!
    if (char === '{') {
      const segment = linkageLine.slice(segmentStart, i)
      if (/^\s*extern(?:\s+|(?="C"))"C"\s*$/.test(segment) || (pendingExternKeyword && /^\s*"C"\s*$/.test(segment))) {
        openBraces.push(i)
      }
      segmentStart = i + 1
    } else if (char === '}' || char === ';') {
      segmentStart = i + 1
    }
  }
  return openBraces
}

function maskCppStructuralTokens(content: string): string {
  const parts: string[] = []
  const spliceOffsets: number[] = []
  let logicalLength = 0
  const rawTokens = /(?<![A-Za-z0-9_])(?:u8|u|U|L)?R"([^ ()\\\t\v\f\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|(?<![A-Za-z0-9_])u8'(?:\\[\s\S]|[^'\\])*'|(?<![0-9A-Fa-f])'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/(?:(?:[^\n]*?)\\\n)*[^\n]*/g
  const rawRanges: Array<[number, number]> = []
  for (const token of content.matchAll(rawTokens)) {
    if (/^(?:u8|u|U|L)?R"/.test(token[0])) rawRanges.push([token.index!, token.index! + token[0].length])
  }
  let physicalStart = 0
  let rawIndex = 0
  while (physicalStart < content.length) {
    const rawRange = rawRanges[rawIndex]
    const spliceAt = content.indexOf('\\\n', physicalStart)
    if (rawRange && (spliceAt < 0 || rawRange[0] < spliceAt)) {
      const beforeRaw = content.slice(physicalStart, rawRange[0])
      parts.push(beforeRaw)
      logicalLength += beforeRaw.length
      const raw = content.slice(rawRange[0], rawRange[1])
      parts.push(raw)
      logicalLength += raw.length
      physicalStart = rawRange[1]
      rawIndex++
    } else if (spliceAt >= 0) {
      const part = content.slice(physicalStart, spliceAt)
      parts.push(part)
      logicalLength += part.length
      spliceOffsets.push(logicalLength)
      physicalStart = spliceAt + 2
    } else {
      const part = content.slice(physicalStart)
      parts.push(part)
      logicalLength += part.length
      physicalStart = content.length
    }
  }
  const logicalContent = parts.join('')
  const tokens = /(?<=[0-9A-Fa-f])'(?=[0-9A-Fa-f])|R"([^ ()\\\t\v\f\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\.|[^"\\\n])*"|(?<![A-Za-z0-9_])u8'(?:\\.|[^'\\\n])*'|(?<![0-9A-Fa-f])'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
  const ranges: Array<[number, number]> = []
  let spliceIndex = 0
  for (const token of logicalContent.matchAll(tokens)) {
    const start = token.index!
    const end = start + token[0].length
    while (spliceOffsets[spliceIndex] !== undefined && spliceOffsets[spliceIndex]! <= start) spliceIndex++
    const physicalTokenStart = start + spliceIndex * 2
    while (spliceOffsets[spliceIndex] !== undefined && spliceOffsets[spliceIndex]! <= end - 1) spliceIndex++
    const physicalTokenEnd = end - 1 + spliceIndex * 2 + 1
    ranges.push([physicalTokenStart, physicalTokenEnd])
  }

  let masked = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    masked += content.slice(cursor, start)
    masked += content.slice(start, end).replace(/[^\n]/g, ' ')
    cursor = end
  }
  return masked + content.slice(cursor)
}

function maskCppDirectives(structuralLines: readonly string[], lines: readonly string[]): string[] {
  let inContinuation = false
  return structuralLines.map((line, index) => {
    const directive = line.trimStart()
    const isDirective = inContinuation || directive.startsWith('#') || directive.startsWith('%:')
    if (!isDirective) return line
    inContinuation = /\\$/.test(lines[index]!)
    return line.replace(/[^\t]/g, ' ')
  })
}

type QuoteKind = "'" | '"' | '`' | null

interface TemplateState {
  delimiter: '"' | '`'
  inExpression: boolean
  expressionDepth: number
  escaped: boolean
  braceInterpolation?: boolean
  verbatim?: boolean
}

type JavaScriptBraceKind = 'object' | 'block' | 'function-expression'

interface RubyHeredocState {
  delimiter: string
  allowIndent: boolean
  interpolating: boolean
}

interface BashHeredocState {
  delimiter: string
  allowIndent: boolean
}

interface RubyLocalScope {
  baseDepth: number
  baseBraceDepth?: number
  sourceIndex?: number
  names: Set<string>
  pendingMethodParameters?: string
  pendingBlockParameters?: string
}

interface RubyDelimitedState {
  opener: string
  closer: string
  paired: boolean
  depth: number
  escaped: boolean
  interpolating: boolean
}

interface RubyInterpolationState {
  braceDepth: number
  quote: QuoteKind | null
  escaped: boolean
  regex: boolean
  regexClass: boolean
  regexEscaped: boolean
  code: string
  sourceIndex: number
}

interface LexicalState {
  blockCommentDepth: number
  quote: QuoteKind
  quoteLength: 0 | 1 | 3
  csharpVerbatimString: boolean
  csharpRawStringQuoteLength: number | null
  escaped: boolean
  regex: boolean
  regexClass: boolean
  regexEscaped: boolean
  templates: TemplateState[]
  canStartRegex: boolean
  parenDepth: number
  parenRegexContexts: boolean[]
  pendingControlParen: boolean
  pendingControlBlock: boolean
  bracketDepth: number
  shellParameterDepth: number
  shellParameterGroupDepths: number[]
  bashAnsiCQuote: boolean
  bashContinuationPrefix: string | null
  bashPendingHeredocPrefix: string | null
  bashArithmeticParenDepth: number | null
  bashHeredocs: BashHeredocState[]
  rubyHeredocs: RubyHeredocState[]
  rubyBlockDepth: number
  rubyBraceDepth: number
  rubyContinuationPrefix: string
  rubyLocalScopes: RubyLocalScope[]
  rubyEndlessMethodBodyPending: boolean
  rubyEndlessMethodBodyParameters: Set<string>
  phpHeredoc: string | null
  phpInCode: boolean
  rubyDelimited: RubyDelimitedState | null
  rubyQuote: QuoteKind
  rubyQuoteEscaped: boolean
  rubyRegex: boolean
  rubyRegexClass: boolean
  rubyRegexEscaped: boolean
  rubyInterpolations: RubyInterpolationState[]
  javascriptBraceKinds: JavaScriptBraceKind[]
  rustRawStringHashes: number | null
  swiftRawStringHashes: number | null
  swiftRawStringQuoteLength: 0 | 1 | 3
  swiftRawRegexHashes: number | null
  swiftRawRegexEscaped: boolean
  rubyEmbeddedDoc: boolean
}

interface BraceScan {
  balance: number
  opens: boolean
  matchingParenEnd?: number
  matchingBraceEnd?: number
}

interface SymbolScope {
  symbol: string
  baseDepth: number
  baseIndent: number
  startLine: number
  mode: 'brace' | 'line' | 'expression' | 'indent' | 'ruby' | 'pending' | 'persistent' | 'phpNamespace' | 'objc'
  hasBody: boolean
  expressionBodyStarted: boolean
  pythonHeaderPending: boolean
  pythonHeaderState: PythonHeaderState
  pendingHasWhereClause?: boolean
  pendingSignatureEndedWithSemicolon?: boolean
  baseParenDepth: number
  baseBracketDepth: number
  rubyDepth: number
  ended: boolean
}

const REGEX_PREFIX_WORDS = new Set([
  'break', 'case', 'continue', 'debugger', 'delete', 'do', 'else', 'in', 'of', 'return', 'throw', 'typeof', 'void', 'yield',
])
const REGEX_PREFIX_CHARS = new Set(['!', '&', '(', '*', '+', ',', '-', '/', ':', ';', '<', '=', '>', '?', '[', '^', '{', '|', '~'])
const IDENTIFIER_LED_BINARY_RE = /^[$_\p{ID_Start}][$\p{ID_Continue}]*(?:(?:\s*(?:\?\.|\.)\s*[$_\p{ID_Start}][$\p{ID_Continue}]*)|(?:\s*\[[^\]]+\]))*\s*(?:\*\*|>>>|>>|<<|<=|>=|===|!==|==|!=|&&|\|\||\?\?|[+\-*\/%&|^<>])\s*\S/u

function newLexicalState(): LexicalState {
  return {
    blockCommentDepth: 0,
    quote: null,
    quoteLength: 0,
    csharpVerbatimString: false,
    csharpRawStringQuoteLength: null,
    escaped: false,
    regex: false,
    regexClass: false,
    regexEscaped: false,
    templates: [],
    canStartRegex: true,
    parenDepth: 0,
    parenRegexContexts: [],
    pendingControlParen: false,
    pendingControlBlock: false,
    bracketDepth: 0,
    shellParameterDepth: 0,
    shellParameterGroupDepths: [],
    bashAnsiCQuote: false,
    bashContinuationPrefix: null,
    bashPendingHeredocPrefix: null,
    bashArithmeticParenDepth: null,
    bashHeredocs: [],
    rubyHeredocs: [],
    rubyBlockDepth: 0,
    rubyBraceDepth: 0,
    rubyContinuationPrefix: '',
    rubyLocalScopes: [{ baseDepth: -1, names: new Set() }],
    rubyEndlessMethodBodyPending: false,
    rubyEndlessMethodBodyParameters: new Set(),
    phpHeredoc: null,
    phpInCode: true,
    rubyDelimited: null,
    rubyQuote: null,
    rubyQuoteEscaped: false,
    rubyRegex: false,
    rubyRegexClass: false,
    rubyRegexEscaped: false,
    rubyInterpolations: [],
    javascriptBraceKinds: [],
    rustRawStringHashes: null,
    swiftRawStringHashes: null,
    swiftRawStringQuoteLength: 0,
    swiftRawRegexHashes: null,
    swiftRawRegexEscaped: false,
    rubyEmbeddedDoc: false,
  }
}

function supportsNestedBlockComments(lang: LanguageDef | null): boolean {
  return lang !== null && ['kotlin', 'rust', 'scala', 'swift'].includes(lang.name)
}

function scalaSymbolLiteralLength(line: string, index: number, lang: LanguageDef | null): number {
  if (lang?.name !== 'scala' || line[index] !== "'") return 0
  const literal = line.slice(index).match(/^'[\p{ID_Start}_$][\p{ID_Continue}$]*/u)?.[0]
  return literal !== undefined && line[index + literal.length] !== "'" ? literal.length : 0
}

function quoteDelimiterLength(line: string, index: number, quote: "'" | '"', lang: LanguageDef | null): 1 | 3 {
  const supportsTripleQuote = lang?.name === 'python' || (quote === '"' && ['java', 'kotlin', 'scala', 'swift'].includes(lang?.name ?? ''))
  return supportsTripleQuote && line.startsWith(quote.repeat(3), index) ? 3 : 1
}

function hasRegexTerminator(line: string, start: number): boolean {
  let inClass = false
  let escaped = false
  for (let i = start + 1; i < line.length; i++) {
    const ch = line[i]!
    if (escaped) {
      escaped = false
    } else if (ch === '\\') {
      escaped = true
    } else if (inClass) {
      if (ch === ']') inClass = false
    } else if (ch === '[') {
      inClass = true
    } else if (ch === '/') {
      return true
    }
  }
  return false
}

function stripPythonComment(line: string): string {
  let quote: QuoteKind = null
  let quoteLength: 0 | 1 | 3 = 0
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (quoteLength === 3 && line.startsWith(quote.repeat(3), i)) {
        quote = null
        quoteLength = 0
        i += 2
      } else if (quoteLength === 1 && ch === quote) {
        quote = null
        quoteLength = 0
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      quoteLength = line.startsWith(ch.repeat(3), i) ? 3 : 1
      if (quoteLength === 3) i += 2
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

interface PythonHeaderState {
  depth: number
  quote: QuoteKind
  quoteLength: 0 | 1 | 3
}

interface PythonHeaderScan extends PythonHeaderState {
  hasTopLevelColon: boolean
  topLevelColonIndex: number | null
}

function scanPythonHeader(line: string, initial: PythonHeaderState = { depth: 0, quote: null, quoteLength: 0 }): PythonHeaderScan {
  let depth = initial.depth
  let quote = initial.quote
  let quoteLength = initial.quoteLength
  let escaped = false
  let hasTopLevelColon = false
  let topLevelColonIndex: number | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (quoteLength === 3 && line.startsWith(quote.repeat(3), i)) {
        quote = null
        quoteLength = 0
        i += 2
      } else if (quoteLength === 1 && ch === quote) {
        quote = null
        quoteLength = 0
      }
      continue
    }
    if (ch === '#') break
    if (ch === '"' || ch === "'") {
      quote = ch
      quoteLength = line.startsWith(ch.repeat(3), i) ? 3 : 1
      if (quoteLength === 3) i += 2
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1)
    } else if (ch === ':' && depth === 0) {
      hasTopLevelColon = true
      topLevelColonIndex = i
    }
  }
  return { depth, quote, quoteLength, hasTopLevelColon, topLevelColonIndex }
}

function previousNonWhitespace(line: string, index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    if (!/\s/.test(line[i]!)) return line[i]!
  }
  return null
}

function nextNonWhitespace(line: string, index: number): string | null {
  for (let i = index + 1; i < line.length; i++) {
    if (!/\s/.test(line[i]!)) return line[i]!
  }
  return null
}

/** A slash after a value can be division even when the following token is a regex. */
function isDivisionBeforeRegex(line: string, index: number): boolean {
  const previous = previousNonWhitespace(line, index)
  return (previous === ']' || previous === '}') && nextNonWhitespace(line, index) === '/'
}

function isJavaScriptControlCondition(prefix: string): boolean {
  const trimmed = prefix.trimEnd()
  return /\b(?:if|while|for|with|switch|catch)\s*$/.test(trimmed)
    && !/(?:\.|\?\.)\s*(?:if|while|for|with|switch|catch)\s*$/.test(trimmed)
}

function isInsideJavaScriptRegex(line: string, index: number, lang: LanguageDef): boolean {
  const state = newLexicalState()
  braceDelta(line, state, lang, undefined, undefined, index)
  return state.regex
}

function isRubyRegexStart(code: string, line: string, index: number): boolean {
  const trimmed = code.trimEnd()
  if (trimmed.length === 0) return true
  const last = trimmed.at(-1)!
  if ('=([{,:;!&|?+-*/%^~<>'.includes(last)) return true
  const word = trimmed.match(/([A-Za-z_]\w*)$/)?.[1]
  if (word !== undefined && new Set(['and', 'begin', 'case', 'do', 'else', 'if', 'not', 'or', 'return', 'then', 'unless', 'until', 'when', 'while']).has(word)) return true
  const commandPrefix = /^[A-Za-z_]\w*[!?]?(?:(?:\.|::)[A-Za-z_]\w*[!?]?)*$/.test(trimmed.trimStart())
  const followingSlash = index + 1 + (line.slice(index + 1).match(/^\s*/)?.[0].length ?? 0)
  if (commandPrefix && line[followingSlash] === '/' && hasRegexTerminator(line, followingSlash + 1)) return false
  return commandPrefix
    && code.length > trimmed.length
    && hasRegexTerminator(line, index)
}

function rubyCodeWithoutLiterals(
  line: string,
  state: LexicalState,
  interpolationExpressions?: Array<{ code: string; index: number }>,
): string {
  let code = ''
  for (const interpolation of state.rubyInterpolations) interpolation.sourceIndex = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    const interpolation = state.rubyInterpolations.at(-1)
    if (interpolation !== undefined) {
      if (interpolation.quote === null && ch !== '#' && ch !== '"' && ch !== "'" && ch !== '`') {
        interpolation.code += interpolation.regex ? ' ' : ch
      }
      if (interpolation.quote !== null) {
        if (interpolation.escaped) {
          interpolation.escaped = false
        } else if (ch === '\\') {
          interpolation.escaped = true
        } else if (ch === interpolation.quote) {
          interpolation.quote = null
        }
      } else if (interpolation.regex) {
        if (interpolation.regexEscaped) {
          interpolation.regexEscaped = false
        } else if (ch === '\\') {
          interpolation.regexEscaped = true
        } else if (interpolation.regexClass) {
          if (ch === ']') interpolation.regexClass = false
        } else if (ch === '[') {
          interpolation.regexClass = true
        } else if (ch === '/') {
          interpolation.regex = false
        }
      } else if (ch === '#') {
        code += ' '.repeat(line.length - i)
        break
      } else if (ch === '"' || ch === "'" || ch === '`') {
        interpolation.quote = ch
        interpolation.escaped = false
      } else if (
        ch === '/'
        && isRubyRegexStart(interpolation.code.slice(0, -1), line, i)
        && hasRegexTerminator(line, i)
      ) {
        interpolation.regex = true
        interpolation.regexClass = false
        interpolation.regexEscaped = false
        interpolation.code = `${interpolation.code.slice(0, -1)} `
      } else if (ch === '{') {
        interpolation.braceDepth++
      } else if (ch === '}' && --interpolation.braceDepth === 0) {
        interpolationExpressions?.push({ code: interpolation.code, index: interpolation.sourceIndex })
        state.rubyInterpolations.pop()
      }
      code += ' '
      continue
    }
    if (state.rubyDelimited !== null) {
      const literal = state.rubyDelimited
      if (literal.escaped) {
        literal.escaped = false
      } else if (ch === '\\') {
        literal.escaped = true
      } else if (literal.interpolating && ch === '#' && line[i + 1] === '{') {
        state.rubyInterpolations.push({
          braceDepth: 1,
          quote: null,
          escaped: false,
          regex: false,
          regexClass: false,
          regexEscaped: false,
          code: '',
          sourceIndex: i,
        })
        code += '  '
        i++
        continue
      } else if (literal.paired && ch === literal.opener) {
        literal.depth++
      } else if (ch === literal.closer) {
        if (!literal.paired || --literal.depth === 0) state.rubyDelimited = null
      }
      code += ' '
      continue
    }
    if (state.rubyQuote !== null) {
      if (state.rubyQuoteEscaped) {
        state.rubyQuoteEscaped = false
      } else if (ch === '\\') {
        state.rubyQuoteEscaped = true
      } else if ((state.rubyQuote === '"' || state.rubyQuote === '`') && ch === '#' && line[i + 1] === '{') {
        state.rubyInterpolations.push({
          braceDepth: 1,
          quote: null,
          escaped: false,
          regex: false,
          regexClass: false,
          regexEscaped: false,
          code: '',
          sourceIndex: i,
        })
        code += '  '
        i++
        continue
      } else if (ch === state.rubyQuote) {
        state.rubyQuote = null
      }
      code += ' '
      continue
    }
    if (state.rubyRegex) {
      if (state.rubyRegexEscaped) {
        state.rubyRegexEscaped = false
      } else if (ch === '\\') {
        state.rubyRegexEscaped = true
      } else if (state.rubyRegexClass) {
        if (ch === ']') state.rubyRegexClass = false
      } else if (ch === '[') {
        state.rubyRegexClass = true
      } else if (ch === '/') {
        state.rubyRegex = false
      }
      code += ' '
      continue
    }
    if (ch === '#') break
    if (ch === '%' && !/[A-Za-z0-9_]/.test(line[i - 1] ?? '')) {
      let delimiterIndex = i + 1
      const delimiterType = /[qQwWiIxrs]/.test(line[delimiterIndex] ?? '') ? line[delimiterIndex++] : null
      const opener = line[delimiterIndex]
      if (opener !== undefined && !/[A-Za-z0-9_\s=]/.test(opener)) {
        const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')', '<': '>' }
        const closer = pairs[opener] ?? opener
        state.rubyDelimited = {
          opener,
          closer,
          paired: closer !== opener,
          depth: 1,
          escaped: false,
          interpolating: !['q', 'w', 'i', 's'].includes(delimiterType ?? 'Q'),
        }
        code += RUBY_LITERAL_MARKER
        i = delimiterIndex
        continue
      }
    }
    if (ch === '"' || ch === "'" || (ch === '`' && !/\bdef\s*$/.test(code))) {
      if (/<<[~-]?\s*$/.test(line.slice(0, i))) {
        const delimiterEnd = line.indexOf(ch, i + 1)
        if (delimiterEnd >= 0) {
          code += line.slice(i, delimiterEnd + 1)
          i = delimiterEnd
          continue
        }
      }
      state.rubyQuote = ch
      state.rubyQuoteEscaped = false
      code += RUBY_LITERAL_MARKER
      continue
    }
    if (ch === '/' && isRubyRegexStart(code, line, i)) {
      state.rubyRegex = true
      state.rubyRegexClass = false
      state.rubyRegexEscaped = false
      code += RUBY_LITERAL_MARKER
      continue
    }
    code += ch
  }
  if (state.rubyQuote !== null) state.rubyQuoteEscaped = false
  if (state.rubyDelimited?.escaped && line.endsWith('\\')) state.rubyDelimited.escaped = false
  if (state.rubyRegexEscaped && line.endsWith('\\')) state.rubyRegexEscaped = false
  for (const interpolation of state.rubyInterpolations) {
    if (interpolation.regexEscaped && line.endsWith('\\')) interpolation.regexEscaped = false
    interpolationExpressions?.push({ code: interpolation.code, index: interpolation.sourceIndex })
  }
  return code
}

function opensJavaScriptBlock(line: string, index: number, state: LexicalState): boolean {
  const prefix = line.slice(0, index).trimEnd()
  return state.pendingControlBlock
    || prefix.length === 0
    || /^(?:[A-Za-z_$][\w$]*\s*:\s*)+$/.test(prefix.trimStart())
    || /(?:=>|\b(?:else|try|finally|do))\s*$/.test(prefix)
    || /\b(?:if|while|for(?:\s+await)?|switch|catch)\s*\([^)]*\)\s*$/.test(prefix)
    || /\bcase\b.*:\s*$/.test(prefix)
    || !state.canStartRegex
}

function isJavaScriptFunctionExpression(line: string, index: number, functionIndex?: number): boolean {
  if (functionIndex === undefined || functionIndex >= index) return false
  const beforeFunction = line.slice(0, functionIndex).trim()
  return beforeFunction.length > 0 && !/^(?:(?:export|default|async)\s+)*$/.test(beforeFunction)
}

function rubyAssignedLocalMatches(code: string): RegExpMatchArray[] {
  const assignments = [
    ...code.matchAll(/(?<![\p{XID_Continue}:.$@])([_\p{XID_Start}][\p{XID_Continue}_]*)\s*(?:\|\|=|&&=|<<=|>>=|\*\*=|[+\-*\/%&|^]?=)(?![=>~])/gu),
    ...code.matchAll(/(?<![\p{XID_Continue}:.$@])([_\p{XID_Start}][\p{XID_Continue}_]*)(?=\s*,\s*(?:\*?\s*[_\p{XID_Start}][\p{XID_Continue}_]*\s*,\s*)*\*?\s*[_\p{XID_Start}][\p{XID_Continue}_]*\s*=(?![=>~]))/gu),
  ]
  return assignments
    .filter((match) => !/\bdef\s+$/.test(code.slice(0, match.index!)))
}

function rubyAssignedLocalNames(code: string): string[] {
  return rubyAssignedLocalMatches(code).map((match) => match[1]!)
}

function rubyHeredocOpeners(
  line: string,
  assignedLocals: ReadonlySet<string>,
  activeLocalsAt?: (index: number) => ReadonlySet<string>,
): RubyHeredocState[] {
  const openers: RubyHeredocState[] = []
  const pattern = /<<([~-]?)(?:(["'`])([^"'`\s]+)\2|([A-Za-z_]\w*))/g
  for (const match of line.matchAll(pattern)) {
    const beforeOperator = line.slice(0, match.index!)
    const delimiter = match[3] ?? match[4]
    const explicitHeredoc = match[1] !== '' || match[2] !== undefined
    const statementStart = Math.max(beforeOperator.lastIndexOf(';'), beforeOperator.lastIndexOf('\n')) + 1
    const assignment = beforeOperator.slice(statementStart).match(/(?<![=!<>])=(?!=)([^;]*)$/)
    const knownLocals = new Set(activeLocalsAt?.(match.index!) ?? assignedLocals)
    const numericReceiver = /(?:^|[^\p{XID_Continue}$])(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)[rRiI]?\s*$/u.test(beforeOperator)
    const assignmentValue = assignment?.[1]?.trim()
    const assignedIdentifier = assignmentValue?.match(/([_\p{XID_Start}][\p{XID_Continue}_]*)$/u)?.[1]
    const assignedValueIsComplete = assignmentValue !== undefined && (
      assignmentValue.endsWith(RUBY_LITERAL_MARKER)
      || /[)\]}]$/.test(assignmentValue)
      || /(?:^|[^\w])\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?$/.test(assignmentValue)
      || /^(?:true|false|nil|self)$/.test(assignmentValue)
      || /^[A-Z]\w*$/.test(assignmentValue)
      || /^(?:@{1,2}|\$)[A-Za-z_]\w*$/.test(assignmentValue)
      || (assignedIdentifier !== undefined && knownLocals.has(assignedIdentifier))
      || /\.[A-Za-z_]\w*[!?]?$/.test(assignmentValue)
    )
    if (assignedValueIsComplete && !explicitHeredoc) continue
    const expressionReceiver = beforeOperator.match(/(?:@{1,2}[_\p{XID_Start}][\p{XID_Continue}_]*|\$[_\p{XID_Start}][\p{XID_Continue}_]*|self|[_\p{XID_Start}][\p{XID_Continue}_]*(?:(?:\.|&\.|::)[_\p{XID_Start}][\p{XID_Continue}_]*[!?]?)*)\s*$/u)?.[0]?.trim()
    const variableReceiver = expressionReceiver !== undefined && (
      expressionReceiver.startsWith('@')
      || expressionReceiver.startsWith('$')
      || expressionReceiver === 'self'
    )
    const memberReceiver = expressionReceiver !== undefined && /(?:\.|&\.|::)/.test(expressionReceiver)
    const receiver = beforeOperator.match(/([_\p{XID_Start}][\p{XID_Continue}_]*)\s*$/u)?.[1]
    if (!explicitHeredoc && numericReceiver) continue
    if (
      !explicitHeredoc
      && !variableReceiver
      && !memberReceiver
      && receiver !== undefined
      && knownLocals.has(receiver)
    ) continue
    if (!explicitHeredoc && variableReceiver) continue
    if (!explicitHeredoc && memberReceiver && delimiter !== undefined && knownLocals.has(delimiter)) continue
    if (!explicitHeredoc && !variableReceiver && !memberReceiver && /[\w)\]}]/.test(beforeOperator.at(-1) ?? '')) continue
    if (delimiter !== undefined) {
      openers.push({
        delimiter,
        allowIndent: match[1] === '-' || match[1] === '~',
        interpolating: match[2] !== "'",
      })
    }
  }
  return openers
}

function rubyHeredocLine(line: string, state: LexicalState): boolean {
  const heredoc = state.rubyHeredocs[0]
  if (heredoc === undefined) return false
  const matches = heredoc.allowIndent ? line.trim() === heredoc.delimiter : line === heredoc.delimiter
  if (matches) state.rubyHeredocs.shift()
  return true
}

function rubyHeredocInterpolationAssignments(line: string): string[] {
  const assignments: string[] = []
  for (const interpolation of line.matchAll(/#\{/g)) {
    let backslashes = 0
    for (let index = interpolation.index! - 1; index >= 0 && line[index] === '\\'; index--) backslashes++
    if (backslashes % 2 === 1) continue
    const state = newLexicalState()
    state.rubyInterpolations.push({
      braceDepth: 1,
      quote: null,
      escaped: false,
      regex: false,
      regexClass: false,
      regexEscaped: false,
      code: '',
      sourceIndex: 0,
    })
    const expressions: Array<{ code: string; index: number }> = []
    rubyCodeWithoutLiterals(line.slice(interpolation.index! + 2), state, expressions)
    const expression = expressions[0]?.code
    if (expression === undefined) continue
    for (const match of rubyAssignedLocalMatches(expression)) {
      const prefix = expression.slice(0, match.index!)
      const closesBefore = prefix.match(/(?<![:\w@$])end\b(?!:)/g)?.length ?? 0
      if (rubyBlockOpenerCount(prefix) - closesBefore > 0) continue
      if ((prefix.match(/{/g)?.length ?? 0) > (prefix.match(/}/g)?.length ?? 0)) continue
      assignments.push(match[1]!)
    }
  }
  return assignments
}

function rubyEmbeddedDocumentationLine(line: string, state: LexicalState): boolean {
  if (state.rubyEmbeddedDoc) {
    if (/^=end(?:\s|$)/.test(line)) state.rubyEmbeddedDoc = false
    return true
  }
  if (/^=begin(?:\s|$)/.test(line)) {
    state.rubyEmbeddedDoc = true
    return true
  }
  return false
}

function bashHeredocDelimiter(
  line: string,
  index: number,
): { delimiter: string; allowIndent: boolean; end: number; continued: boolean } | null {
  let cursor = index + 2
  const allowIndent = line[cursor] === '-'
  if (allowIndent) cursor++
  while (/[ \t]/.test(line[cursor] ?? '')) cursor++

  let delimiter = ''
  let continued = false
  let quote: "'" | '"' | null = null
  while (cursor < line.length) {
    const ch = line[cursor]!
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else if (ch === '\\' && quote === '"' && cursor + 1 < line.length && /[\\"$`]/.test(line[cursor + 1]!)) {
        delimiter += line[++cursor]!
      } else if (ch === '\\' && quote === '"' && cursor + 1 === line.length) {
        continued = true
        break
      } else {
        delimiter += ch
      }
      cursor++
      continue
    }
    if (/[ \t;&|<>()]/.test(ch)) break
    if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === '\\' && cursor + 1 < line.length) {
      delimiter += line[++cursor]!
    } else if (ch === '\\' && cursor + 1 === line.length) {
      continued = true
      break
    } else {
      delimiter += ch
    }
    cursor++
  }
  if ((quote !== null && !continued) || delimiter.length === 0) return null
  return { delimiter, allowIndent, end: continued ? cursor : cursor - 1, continued }
}

function isBashGroupBraceToken(
  line: string,
  index: number,
  state: LexicalState,
  opening: boolean,
  continuedPrefix = '',
): boolean {
  if (state.shellParameterDepth > 0) return true
  const before = `${continuedPrefix}${line.slice(0, index)}`.trimEnd()
  const next = line[index + 1]
  if (next !== undefined && !/[\s;|&()<>]/.test(next)) return false
  if (opening) {
    return before.length === 0
      || /[;|&()<>]$/.test(before)
      || /\b(?:if|while|until|then|do|else|coproc(?:\s+\w+)?)\s*$/.test(before)
      || /(?:^|[;|&()<>]|\b(?:if|while|until|then|do|else|coproc(?:\s+\w+)?))\s*!\s*$/.test(before)
      || /^(?:function\s+\w+(?:\s*\(\s*\))?|\w+\s*\(\s*\))$/.test(before)
  }
  return before.length === 0 || /[;&|]$/.test(before)
}

/** Count block braces while preserving lexical state between source lines. */
function braceDelta(
  line: string,
  state: LexicalState,
  lang: LanguageDef | null,
  matchParenDepth?: number,
  matchBraceDepth?: number,
  stopAtIndex?: number,
): BraceScan {
  const bashContinuationPrefix = lang?.name === 'bash' && stopAtIndex === undefined
    ? state.bashContinuationPrefix ?? ''
    : ''
  if (lang?.name === 'bash' && stopAtIndex === undefined) state.bashContinuationPrefix = null
  let completedBashHeredoc: LexicalState['bashHeredocs'][number] | null = null
  let unresolvedBashHeredocPrefix: string | null = null
  let bashContinuationScanStart = 0
  if (lang?.name === 'bash' && stopAtIndex === undefined && state.bashPendingHeredocPrefix !== null) {
    const pendingPrefix = state.bashPendingHeredocPrefix
    const continuedLine = pendingPrefix + line
    state.bashPendingHeredocPrefix = null
    const pendingHeredoc = bashHeredocDelimiter(continuedLine, 0)
    if (pendingHeredoc === null) {
      unresolvedBashHeredocPrefix = continuedLine
    } else if (pendingHeredoc.continued) {
      unresolvedBashHeredocPrefix = continuedLine.slice(0, pendingHeredoc.end)
    } else {
      completedBashHeredoc = {
        delimiter: pendingHeredoc.delimiter,
        allowIndent: pendingHeredoc.allowIndent,
      }
      bashContinuationScanStart = Math.max(0, pendingHeredoc.end + 1 - pendingPrefix.length)
      unresolvedBashHeredocPrefix = continuedLine
    }
  }
  if (lang?.name === 'bash' && state.bashHeredocs.length > 0) {
    const heredoc = state.bashHeredocs[0]!
    const terminator = heredoc.allowIndent ? line.replace(/^\t+/, '') : line
    if (terminator === heredoc.delimiter) state.bashHeredocs.shift()
    return { balance: 0, opens: false }
  }
  if (lang?.name === 'ruby' && state.rubyHeredocs.length > 0) return { balance: 0, opens: false }
  let balance = 0
  let opens = false
  let matchingParenEnd: number | undefined
  let matchingBraceEnd: number | undefined
  let bashCommentStart: number | null = null
  let javascriptFunctionKeywordIndex: number | undefined
  for (let i = bashContinuationScanStart; i < (stopAtIndex ?? line.length); i++) {
    const ch = line[i]!
    if (lang?.name === 'php' && !state.phpInCode) {
      const openingTag = line.slice(i).match(/<\?(?:php\b|=|(?!xml\b))/i)
      if (!openingTag) break
      state.phpInCode = true
      i += openingTag.index! + openingTag[0].length - 1
      continue
    }
    if (lang?.name === 'php' && state.phpHeredoc !== null) {
      const terminator = line.slice(i).match(/^\s*([A-Za-z_]\w*)/)
      const suffix = terminator === null ? '' : line.slice(i + terminator[0].length).trimStart()
      if (
        !terminator
        || terminator[1] !== state.phpHeredoc
        || (suffix.length > 0 && /[A-Za-z0-9_$]/.test(suffix[0]!))
      ) return { balance: 0, opens: false }
      state.phpHeredoc = null
      i += terminator[0].length - 1
      continue
    }
    if (state.blockCommentDepth > 0) {
      if (supportsNestedBlockComments(lang) && ch === '/' && line[i + 1] === '*') {
        state.blockCommentDepth++
        i++
      } else if (ch === '*' && line[i + 1] === '/') {
        state.blockCommentDepth--
        i++
      }
      continue
    }

    if (lang?.name === 'rust' && state.rustRawStringHashes !== null) {
      const hashes = '#'.repeat(state.rustRawStringHashes)
      if (ch === '"' && line.startsWith(hashes, i + 1)) {
        state.rustRawStringHashes = null
        i += hashes.length
      }
      continue
    }

    if (lang?.name === 'swift' && state.swiftRawStringHashes !== null) {
      const terminator = '"'.repeat(state.swiftRawStringQuoteLength) + '#'.repeat(state.swiftRawStringHashes)
      if (line.startsWith(terminator, i)) {
        state.swiftRawStringHashes = null
        state.swiftRawStringQuoteLength = 0
        i += terminator.length - 1
      }
      continue
    }

    if (lang?.name === 'swift' && state.swiftRawRegexHashes !== null) {
      const terminator = `/${'#'.repeat(state.swiftRawRegexHashes)}`
      if (state.swiftRawRegexEscaped) {
        state.swiftRawRegexEscaped = false
      } else if (ch === '\\') {
        state.swiftRawRegexEscaped = true
      } else if (line.startsWith(terminator, i)) {
        state.swiftRawRegexHashes = null
        state.canStartRegex = false
        i += terminator.length - 1
      }
      continue
    }

    if (lang?.name === 'csharp' && state.csharpRawStringQuoteLength !== null) {
      const terminator = '"'.repeat(state.csharpRawStringQuoteLength)
      if (line.startsWith(terminator, i)) {
        state.csharpRawStringQuoteLength = null
        state.canStartRegex = false
        i += terminator.length - 1
      }
      continue
    }

    if (state.quote !== null) {
      if (lang?.name === 'bash' && state.quote === "'") {
        if (state.bashAnsiCQuote && state.escaped) {
          state.escaped = false
        } else if (state.bashAnsiCQuote && ch === '\\') {
          state.escaped = true
        } else if (ch === "'") {
          state.quote = null
          state.quoteLength = 0
          state.bashAnsiCQuote = false
          state.canStartRegex = false
        }
        continue
      }
      if (lang?.name === 'bash' && state.quote === '"') {
        if (ch === '\\') {
          let runEnd = i
          while (line[runEnd + 1] === '\\') runEnd++
          if (line[runEnd + 1] === '"') {
            if ((runEnd - i + 1) % 2 === 0) {
              state.quote = null
              state.quoteLength = 0
              state.canStartRegex = false
            }
            i = runEnd + 1
          } else {
            i = runEnd
          }
        } else if (ch === '"') {
          state.quote = null
          state.quoteLength = 0
          state.canStartRegex = false
        }
        continue
      }
      if (lang?.name === 'go' && state.quote === '`') {
        if (ch === '`') {
          state.quote = null
          state.quoteLength = 0
          state.canStartRegex = false
        }
        continue
      }
      if (lang?.name === 'csharp' && state.csharpVerbatimString) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            i++
          } else {
            state.quote = null
            state.quoteLength = 0
            state.csharpVerbatimString = false
            state.canStartRegex = false
          }
        }
        continue
      }
      const tripleQuote = state.quoteLength === 3
      const supportsEscapes = !tripleQuote || ['java', 'python', 'swift'].includes(lang?.name ?? '')
      if (state.escaped) {
        state.escaped = false
      } else if (ch === '\\' && supportsEscapes) {
        state.escaped = true
      } else if (tripleQuote && line.startsWith(state.quote.repeat(3), i)) {
        state.quote = null
        state.quoteLength = 0
        state.canStartRegex = false
        i += 2
      } else if (!tripleQuote && ch === state.quote) {
        state.quote = null
        state.quoteLength = 0
        state.canStartRegex = false
      }
      continue
    }

    if (state.regex) {
      if (state.regexEscaped) {
        state.regexEscaped = false
      } else if (ch === '\\') {
        state.regexEscaped = true
      } else if (state.regexClass) {
        if (ch === ']') state.regexClass = false
      } else if (ch === '[') {
        state.regexClass = true
      } else if (ch === '/') {
        state.regex = false
        state.canStartRegex = false
      }
      continue
    }

    const template = state.templates.at(-1)
    if (template && !template.inExpression) {
      if (template.verbatim && ch === '"') {
        if (line[i + 1] === '"') {
          i++
        } else {
          state.templates.pop()
          state.canStartRegex = false
        }
      } else if (template.escaped) {
        template.escaped = false
      } else if (ch === '\\' && !template.verbatim) {
        template.escaped = true
      } else if (ch === template.delimiter) {
        state.templates.pop()
        state.canStartRegex = false
      } else if (template.braceInterpolation && (line.startsWith('{{', i) || line.startsWith('}}', i))) {
        i++
      } else if (
        (template.braceInterpolation && ch === '{')
        || (!template.braceInterpolation && ch === '$' && line[i + 1] === '{')
      ) {
        template.inExpression = true
        template.expressionDepth = 1
        state.canStartRegex = true
        if (!template.braceInterpolation) i++
      }
      continue
    }

    if (template?.inExpression) {
      if (ch === '{') {
        template.expressionDepth++
        balance++
        opens = true
        const isBlock = opensJavaScriptBlock(line, i, state)
        const isFunctionExpression = isBlock && isJavaScriptFunctionExpression(line, i, javascriptFunctionKeywordIndex)
        state.javascriptBraceKinds.push(isFunctionExpression ? 'function-expression' : isBlock ? 'block' : 'object')
        state.pendingControlBlock = false
        state.canStartRegex = true
        continue
      }
      if (ch === '}') {
        if (template.expressionDepth > 1) {
          template.expressionDepth--
          const previousBalance = balance
          balance--
          if (
            matchBraceDepth !== undefined
            && previousBalance > matchBraceDepth
            && balance === matchBraceDepth
            && matchingBraceEnd === undefined
          ) matchingBraceEnd = i
          const braceKind = state.javascriptBraceKinds.pop()
          state.canStartRegex = braceKind === undefined || braceKind === 'block'
        } else {
          template.inExpression = false
          state.canStartRegex = false
        }
        continue
      }
    }

    const javascript = lang?.name === 'javascript' || lang?.name === 'typescript'
    const startsComment = ch === '/' && (
      (line[i + 1] === '/' && lang?.commentPrefixes.includes('//'))
      || (line[i + 1] === '*' && lang?.commentPrefixes.includes('/*'))
    )
    const awaitModifier = javascript && state.pendingControlParen && /^await\b/.test(line.slice(i))
    if (state.pendingControlParen && !/\s/.test(ch) && ch !== '(' && !startsComment && !awaitModifier) {
      state.pendingControlParen = false
    }
    if (state.pendingControlBlock && !/\s/.test(ch) && ch !== '{' && !startsComment) {
      state.pendingControlBlock = false
    }

    if (javascript && ch === '=' && line[i + 1] === '>') {
      state.canStartRegex = true
      i++
      continue
    }
    if (
      (lang?.name === 'javascript' || lang?.name === 'typescript') &&
      ((ch === '+' && line[i + 1] === '+') || (ch === '-' && line[i + 1] === '-'))
    ) {
      state.canStartRegex = false
      i++
      continue
    }
    if (lang?.name === 'rust' && (i === 0 || !/[\w]/.test(line[i - 1]!))) {
      const rawString = line.slice(i).match(/^(?:br|cr|r)(#{0,})"/)
      if (rawString) {
        state.rustRawStringHashes = rawString[1]!.length
        i += rawString[0].length - 1
        continue
      }
    }
    if (lang?.name === 'swift' && ch === '#') {
      const rawRegex = state.canStartRegex ? line.slice(i).match(/^(#+)\//) : null
      if (rawRegex) {
        state.swiftRawRegexHashes = rawRegex[1]!.length
        state.swiftRawRegexEscaped = false
        state.canStartRegex = false
        i += rawRegex[0].length - 1
        continue
      }
      const rawString = line.slice(i).match(/^(#+)("""|")/)
      if (rawString) {
        state.swiftRawStringHashes = rawString[1]!.length
        state.swiftRawStringQuoteLength = rawString[2]!.length as 1 | 3
        i += rawString[0].length - 1
        continue
      }
    }
    if (lang?.name === 'php' && ch === '<' && line.startsWith('<<<', i)) {
      const heredoc = line.slice(i).match(/^<<<\s*(?:(["'])([A-Za-z_]\w*)\1|([A-Za-z_]\w*))/)
      const delimiter = heredoc?.[2] ?? heredoc?.[3]
      if (heredoc && delimiter) {
        state.phpHeredoc = delimiter
        i += heredoc[0].length - 1
        continue
      }
    }
    if (lang?.name === 'bash' && state.bashArithmeticParenDepth === null && line.startsWith('((', i)) {
      state.bashArithmeticParenDepth = 0
      state.parenDepth += 2
      state.canStartRegex = true
      i++
      continue
    }
    if (lang?.name === 'bash' && state.bashArithmeticParenDepth !== null) {
      if (ch === '(') {
        state.bashArithmeticParenDepth++
      } else if (ch === ')') {
        if (state.bashArithmeticParenDepth === 0 && line[i + 1] === ')') {
          state.bashArithmeticParenDepth = null
          state.parenDepth = Math.max(0, state.parenDepth - 2)
          state.canStartRegex = false
          i++
          continue
        }
        if (state.bashArithmeticParenDepth > 0) state.bashArithmeticParenDepth--
      }
    }
    if (lang?.name === 'bash' && ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const heredoc = state.bashArithmeticParenDepth !== null ? null : bashHeredocDelimiter(line, i)
      if (heredoc !== null) {
        if (heredoc.continued) {
          state.bashPendingHeredocPrefix = line.slice(i, heredoc.end)
        } else {
          state.bashHeredocs.push({ delimiter: heredoc.delimiter, allowIndent: heredoc.allowIndent })
        }
        i = heredoc.end
        continue
      }
    }
    if (lang?.name === 'bash' && ch === '\\') {
      i++
      continue
    }
    if (ch === '/' && line[i + 1] === '*' && lang?.commentPrefixes.includes('/*')) {
      state.blockCommentDepth = 1
      i++
      continue
    }
    if (ch === '/' && line[i + 1] === '/' && lang?.commentPrefixes.includes('//')) {
      const closeTag = lang.name === 'php' ? line.indexOf('?>', i + 2) : -1
      if (closeTag < 0) break
      state.phpInCode = false
      i = closeTag + 1
      continue
    }
    if (
      ch === '#' &&
      lang?.commentPrefixes.includes('#') &&
      !(lang.name === 'bash' && (
        state.shellParameterDepth > 0
        || (i > 0 && !/[\s;|&()<>]/.test(line[i - 1]!))
      ))
    ) {
      const closeTag = lang.name === 'php' ? line.indexOf('?>', i + 1) : -1
      if (closeTag < 0) {
        if (lang.name === 'bash') bashCommentStart = i
        break
      }
      state.phpInCode = false
      i = closeTag + 1
      continue
    }
    if (lang?.name === 'php' && ch === '?' && line[i + 1] === '>') {
      state.phpInCode = false
      i++
      continue
    }
    if (lang?.name === 'bash' && ch === '$' && line[i + 1] === '{') {
      state.shellParameterDepth++
      state.shellParameterGroupDepths.push(0)
    }
    const scalaSymbolLength = scalaSymbolLiteralLength(line, i, lang)
    if (scalaSymbolLength > 0) {
      i += scalaSymbolLength - 1
      continue
    }
    if (ch === "'" && lang?.name === 'scala' && (line[i + 1] === '{' || line[i + 1] === '[')) continue
    if (ch === "'" && lang?.name === 'rust') {
      const lifetime = line.slice(i).match(/^'[\p{ID_Start}_][\p{ID_Continue}]*/u)?.[0]
      if (lifetime !== undefined && line[i + lifetime.length] !== "'") continue
    }
    if (
      ch === "'" && lang?.name === 'cpp'
      && !/(?:^|[^A-Za-z0-9_])u8$/.test(line.slice(0, i))
      && /[0-9A-Fa-f]/.test(line[i - 1] ?? '')
      && /[0-9A-Fa-f]/.test(line[i + 1] ?? '')
    ) continue
    if (ch === '"' || ch === "'") {
      if (lang?.name === 'kotlin' && ch === '"' && quoteDelimiterLength(line, i, ch, lang) === 1) {
        state.templates.push({ delimiter: '"', inExpression: false, expressionDepth: 0, escaped: false })
        state.canStartRegex = false
        continue
      }
      if (lang?.name === 'csharp' && ch === '"') {
        const quoteRun = line.slice(i).match(/^"+/)?.[0].length ?? 0
        if (quoteRun >= 3) {
          state.csharpRawStringQuoteLength = quoteRun
          state.canStartRegex = false
          i += quoteRun - 1
          continue
        }
        const stringPrefix = line.slice(0, i)
        if (/(?:@\$|\$@|\$)\s*$/.test(stringPrefix)) {
          state.templates.push({
            delimiter: '"',
            inExpression: false,
            expressionDepth: 0,
            escaped: false,
            braceInterpolation: true,
            verbatim: /(?:@\$|\$@)\s*$/.test(stringPrefix),
          })
          state.canStartRegex = false
          continue
        }
        state.csharpVerbatimString = /@\s*$/.test(stringPrefix)
      }
      state.quote = ch
      state.quoteLength = quoteDelimiterLength(line, i, ch, lang)
      state.escaped = false
      state.bashAnsiCQuote = lang?.name === 'bash' && ch === "'" && line[i - 1] === '$'
      state.canStartRegex = false
      if (state.quoteLength === 3) i += 2
      continue
    }
    if (ch === '`') {
      if (lang?.name === 'javascript' || lang?.name === 'typescript') {
        state.templates.push({ delimiter: '`', inExpression: false, expressionDepth: 0, escaped: false })
      } else {
        state.quote = '`'
        state.quoteLength = 1
        state.escaped = false
      }
      state.canStartRegex = false
      continue
    }
    if (
      (javascript || lang?.name === 'swift') &&
      ch === '/' &&
      state.canStartRegex &&
      !isDivisionBeforeRegex(line, i) &&
      hasRegexTerminator(line, i)
    ) {
      state.regex = true
      state.regexClass = false
      state.regexEscaped = false
      continue
    }
    const isBashBrace = lang?.name !== 'bash'
      || isBashGroupBraceToken(line, i, state, ch === '{', bashContinuationPrefix)
    if (ch === '{' && isBashBrace) {
      if (lang?.name === 'bash' && state.shellParameterDepth > 0 && line[i - 1] !== '$') {
        const parameterIndex = state.shellParameterGroupDepths.length - 1
        if (parameterIndex >= 0) {
          state.shellParameterGroupDepths[parameterIndex] = state.shellParameterGroupDepths[parameterIndex]! + 1
        }
      }
      balance++
      opens = true
      if (lang?.name === 'javascript' || lang?.name === 'typescript') {
        const isBlock = opensJavaScriptBlock(line, i, state)
        const isFunctionExpression = isBlock && isJavaScriptFunctionExpression(line, i, javascriptFunctionKeywordIndex)
        state.javascriptBraceKinds.push(isFunctionExpression ? 'function-expression' : isBlock ? 'block' : 'object')
        state.pendingControlBlock = false
      }
      state.canStartRegex = true
    } else if (ch === '}' && isBashBrace) {
      const previousBalance = balance
      balance--
      if (
        matchBraceDepth !== undefined
        && previousBalance > matchBraceDepth
        && balance === matchBraceDepth
        && matchingBraceEnd === undefined
      ) matchingBraceEnd = i
      if (lang?.name === 'bash' && state.shellParameterDepth > 0) {
        const parameterIndex = state.shellParameterGroupDepths.length - 1
        if (parameterIndex >= 0 && state.shellParameterGroupDepths[parameterIndex]! > 0) {
          state.shellParameterGroupDepths[parameterIndex] = state.shellParameterGroupDepths[parameterIndex]! - 1
        } else {
          state.shellParameterDepth--
          state.shellParameterGroupDepths.pop()
        }
      }
      const isJavaScript = lang?.name === 'javascript' || lang?.name === 'typescript'
      const braceKind = isJavaScript ? state.javascriptBraceKinds.pop() : undefined
      state.canStartRegex = !isJavaScript || braceKind === undefined || braceKind === 'block'
    } else if (ch === ')' || ch === '(') {
      if (ch === '(') {
        state.parenDepth++
        const isControlCondition =
          (lang?.name === 'javascript' || lang?.name === 'typescript')
          && (state.pendingControlParen || isJavaScriptControlCondition(line.slice(0, i)))
        state.pendingControlParen = false
        state.parenRegexContexts.push(isControlCondition)
        state.canStartRegex = true
      } else {
        state.parenDepth = Math.max(0, state.parenDepth - 1)
        if (matchParenDepth !== undefined && state.parenDepth === matchParenDepth && matchingParenEnd === undefined) {
          matchingParenEnd = i
        }
        const wasControlCondition = state.parenRegexContexts.pop() ?? false
        state.canStartRegex = wasControlCondition
        state.pendingControlBlock = wasControlCondition
      }
    } else if (ch === '[' || ch === ']') {
      if (ch === '[') state.bracketDepth++
      else state.bracketDepth = Math.max(0, state.bracketDepth - 1)
      state.canStartRegex = ch === '['
    } else if (/\s/.test(ch)) {
      continue
    } else if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1
      while (end < line.length && /[\w$]/.test(line[end]!)) end++
      const word = line.slice(i, end)
      if (lang?.name === 'javascript' || lang?.name === 'typescript') {
        if (word === 'function' && !/[.?]\s*$/.test(line.slice(0, i))) {
          javascriptFunctionKeywordIndex = i
        }
        state.pendingControlParen = isJavaScriptControlCondition(line.slice(0, end))
          || (state.pendingControlParen && word === 'await')
      }
      state.canStartRegex = REGEX_PREFIX_WORDS.has(word)
        || ((lang?.name === 'javascript' || lang?.name === 'typescript') && ['await', 'instanceof'].includes(word))
      i = end - 1
    } else if (/[0-9]/.test(ch)) {
      state.canStartRegex = false
    } else {
      state.canStartRegex = REGEX_PREFIX_CHARS.has(ch)
    }
  }
  for (const template of state.templates) {
    if (!template.inExpression) template.escaped = false
  }
  if (state.escaped) state.escaped = false
  const activeCode = line.slice(0, bashCommentStart ?? line.length)
  const trailingBackslashes = lang?.name === 'bash' && stopAtIndex === undefined
    ? activeCode.match(/\\+$/)?.[0].length ?? 0
    : 0
  if (trailingBackslashes % 2 === 1 && state.quote !== "'") {
    state.bashContinuationPrefix = `${bashContinuationPrefix}${activeCode.slice(0, -1)}`
  }
  if (lang?.name === 'bash' && stopAtIndex === undefined) {
    if (completedBashHeredoc !== null && state.bashContinuationPrefix !== null) {
      state.bashPendingHeredocPrefix = unresolvedBashHeredocPrefix
    } else if (completedBashHeredoc !== null) {
      state.bashHeredocs.push(completedBashHeredoc)
    } else if (unresolvedBashHeredocPrefix !== null) {
      state.bashPendingHeredocPrefix = unresolvedBashHeredocPrefix
    }
  }
  return { balance, opens, matchingParenEnd, matchingBraceEnd }
}

function usesBraceScopes(lang: LanguageDef | null): boolean {
  if (!lang) return false
  return !['python', 'ruby'].includes(lang.name)
}

function kotlinFunctionParameterStart(line: string, functionStart: number): number {
  let cursor = functionStart + 'fun'.length
  while (/\s/.test(line[cursor] ?? '')) cursor++
  if (line[cursor] !== '<') return kotlinParameterStartAfterReceiver(line, cursor)

  let depth = 0
  for (let i = cursor; i < line.length; i++) {
    if (line[i] === '<') depth++
    else if (line[i] === '>' && line[i - 1] !== '-') {
      depth--
      if (depth === 0) return kotlinParameterStartAfterReceiver(line, i + 1)
    }
  }
  return -1
}

function kotlinParameterStartAfterReceiver(line: string, start: number): number {
  const firstParen = line.indexOf('(', start)
  if (firstParen < 0) return -1
  let depth = 0
  let receiverClose = -1
  for (let i = firstParen; i < line.length; i++) {
    if (line[i] === '(') depth++
    else if (line[i] === ')' && --depth === 0) {
      receiverClose = i
      break
    }
  }
  if (receiverClose < 0) return firstParen
  let cursor = receiverClose + 1
  while (/\s/.test(line[cursor] ?? '')) cursor++
  if (line[cursor] === '?') {
    cursor++
    while (/\s/.test(line[cursor] ?? '')) cursor++
  }
  if (line[cursor] !== '.') return firstParen
  cursor++
  while (/\s/.test(line[cursor] ?? '')) cursor++
  if (line[cursor] === '`') {
    const closingTick = line.indexOf('`', cursor + 1)
    if (closingTick < 0) return firstParen
    cursor = closingTick + 1
  } else {
    const name = line.slice(cursor).match(/^[_\p{ID_Start}][_\p{ID_Continue}]*/u)
    if (name === null) return firstParen
    cursor += name[0].length
  }
  while (/\s/.test(line[cursor] ?? '')) cursor++
  return line[cursor] === '(' ? cursor : firstParen
}

function hasKotlinExpressionBody(line: string): boolean {
  const functionStart = line.search(/\bfun\b/)
  if (functionStart < 0) return false
  const parameterStart = kotlinFunctionParameterStart(line, functionStart)
  if (parameterStart < 0) return /=/.test(line.slice(functionStart))
  let depth = 0
  let quote: "'" | '"' | null = null
  let escaped = false
  for (let i = parameterStart; i < line.length; i++) {
    const ch = line[i]!
    if (quote !== null) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '(') {
      depth++
    } else if (ch === ')' && --depth === 0) {
      return hasKotlinExpressionEquals(line.slice(i + 1))
    }
  }
  return false
}

function hasKotlinExpressionEquals(suffix: string): boolean {
  let blockCommentDepth = 0
  for (let i = 0; i < suffix.length; i++) {
    if (blockCommentDepth > 0) {
      if (suffix.startsWith('/*', i)) {
        blockCommentDepth++
        i++
      } else if (suffix.startsWith('*/', i)) {
        blockCommentDepth--
        i++
      }
      continue
    }
    if (suffix.startsWith('//', i)) return false
    if (suffix.startsWith('/*', i)) {
      blockCommentDepth = 1
      i++
      continue
    }
    if (suffix.startsWith('"""', i)) {
      const close = suffix.indexOf('"""', i + 3)
      if (close < 0) return false
      i = close + 2
      continue
    }
    const ch = suffix[i]!
    if (ch === '"' || ch === "'") {
      let escaped = false
      for (i++; i < suffix.length; i++) {
        if (escaped) escaped = false
        else if (suffix[i] === '\\') escaped = true
        else if (suffix[i] === ch) break
      }
      continue
    }
    if (ch === '=' && suffix[i - 1] !== '=' && suffix[i + 1] !== '=') return true
  }
  return false
}

function hasIncompleteIfExpression(line: string, lang: LanguageDef, nextCodeLine?: string): boolean {
  const nextStartsElse = nextCodeLine !== undefined
    && /^else\b/.test(stripInlineComments(nextCodeLine, lang).trim())
  if (lang.name === 'kotlin') {
    const code = stripInlineComments(line, lang)
    const functionStart = code.search(/\bfun\b/)
    const parameterStart = functionStart < 0 ? -1 : kotlinFunctionParameterStart(code, functionStart)
    if (parameterStart < 0) return false
    const suffix = functionParameterSuffix(line, parameterStart, lang)
    const expression = suffix?.match(/=\s*(if\b.*)$/)?.[1]
    if (expression === undefined) return false
    const conditionStart = expression.indexOf('(')
    if (conditionStart < 0) return false
    const condition = braceDelta(expression.slice(conditionStart), newLexicalState(), lang, 0)
    return condition.matchingParenEnd !== undefined && (
      expression.slice(conditionStart + condition.matchingParenEnd + 1).trim().length === 0
      || /\belse\s*$/.test(expression)
      || nextStartsElse
    )
  }
  if (lang.name === 'scala') {
    const code = stripInlineComments(line, lang)
    const bodyEquals = scalaExpressionBodyEquals(code, lang)
    const expression = bodyEquals === null ? '' : code.slice(bodyEquals + 1).trim()
    return bodyEquals !== null && (
      /^if\b[\s\S]*\bthen\s*$/.test(expression)
      || /^if\b[\s\S]*\belse\s*$/.test(expression)
      || (nextStartsElse && /^if\b/.test(expression))
    )
  }
  return false
}

function hasKotlinDefaultParameter(line: string): boolean {
  const functionStart = line.search(/\bfun\b/)
  if (functionStart < 0) return false
  const parameterStart = kotlinFunctionParameterStart(line, functionStart)
  if (parameterStart < 0) return false
  let depth = 0
  let quote: "'" | '"' | null = null
  let escaped = false
  let hasDefault = false
  for (let i = parameterStart; i < line.length; i++) {
    const ch = line[i]!
    if (quote !== null) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
      if (depth === 0) return hasDefault
    } else if (ch === '=' && depth === 1 && line[i + 1] !== '=' && line[i - 1] !== '=') {
      hasDefault = true
    }
  }
  return hasDefault
}

function scalaExpressionBodyEquals(line: string, lang: LanguageDef | null): number | null {
  const definitionStart = line.search(/\bdef\b/)
  if (definitionStart < 0) return null
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let quote: "'" | '"' | null = null
  let quoteLength: 1 | 3 = 1
  let escaped = false
  for (let i = definitionStart; i < line.length; i++) {
    const ch = line[i]!
    if (quote !== null) {
      if (escaped) escaped = false
      else if (quoteLength === 1 && ch === '\\') escaped = true
      else if (quoteLength === 3 && line.startsWith('"""', i)) {
        quote = null
        quoteLength = 1
        i += 2
      } else if (quoteLength === 1 && ch === quote) quote = null
      continue
    }
    const scalaSymbolLength = scalaSymbolLiteralLength(line, i, lang)
    if (scalaSymbolLength > 0) {
      i += scalaSymbolLength - 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      quoteLength = quoteDelimiterLength(line, i, ch, lang)
      if (quoteLength === 3) i += 2
    } else if (ch === '(') {
      parenDepth++
    } else if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (ch === '[') {
      bracketDepth++
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (ch === '{') {
      braceDepth++
    } else if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (
      ch === '=' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0
      && line[i + 1] !== '=' && line[i + 1] !== '>'
      && line[i - 1] !== '=' && line[i - 1] !== '<' && line[i - 1] !== '>' && line[i - 1] !== '!'
    ) return i
  }
  return null
}

function isScalaRefinementHeader(line: string, lang: LanguageDef | null): boolean {
  if (lang?.name !== 'scala' || !/\bdef\b/.test(line)) return false
  const code = stripInlineComments(line, lang).trim()
  const parameterClose = code.lastIndexOf(')')
  const returnType = code.slice(parameterClose + 1)
  return returnType.includes(':')
    && returnType.includes('{')
    && scalaExpressionBodyEquals(code, lang) === null
}

function hasIncompleteExpression(line: string, lang: LanguageDef, nextCodeLine?: string): boolean {
  const isExpressionDeclaration =
    ((lang.name === 'javascript' || lang.name === 'typescript') && (/=>/.test(line) || /^\s*(?:export\s+)?type\b.*=/.test(line))) ||
    (lang.name === 'kotlin' && hasKotlinExpressionBody(line)) ||
    (lang.name === 'scala' && scalaExpressionBodyEquals(line, lang) !== null)
  if (!isExpressionDeclaration) return false
  if ((lang.name === 'kotlin' || lang.name === 'scala') && hasIncompleteIfExpression(line, lang, nextCodeLine)) return true
  if ((lang.name === 'kotlin' || lang.name === 'scala') && lineEndsWithContinuationOperator(line, lang)) return true
  const state = newLexicalState()
  braceDelta(line, state, lang)
  return state.parenDepth > 0 || state.bracketDepth > 0 || state.blockCommentDepth > 0 || state.quote !== null || state.regex || state.templates.length > 0
}

function genericReturnTypeStatus(
  signature: string,
  lang: LanguageDef,
): 'incomplete' | 'complete' | null {
  let returnType: string | null = null
  let open: '<' | '['
  let close: '>' | ']'
  if (lang.name === 'kotlin') {
    const functionStart = signature.search(/\bfun\b/)
    const parameterStart = functionStart < 0 ? -1 : kotlinFunctionParameterStart(signature, functionStart)
    if (parameterStart < 0) return null
    const suffix = functionParameterSuffix(signature, parameterStart, lang)
    if (suffix === null || !suffix.trimStart().startsWith(':')) return null
    returnType = suffix.slice(suffix.indexOf(':') + 1)
    open = '<'
    close = '>'
  } else if (lang.name === 'scala') {
    const definitionStart = signature.search(/\bdef\b/)
    if (definitionStart < 0) return null
    const methodName = signature.slice(definitionStart).match(
      /^\s*def\s+(?:[\p{ID_Start}_$][\p{ID_Continue}$]*|`[^`]+`|[!#%&*+\-\/:<=>?@\\^|~]+)/u,
    )?.[0]
    if (methodName === undefined) return null
    let cursor = definitionStart + methodName.length
    while (/\s/.test(signature[cursor] ?? '')) cursor++
    const skipBalanced = (start: number, left: string, right: string): number => {
      if (left === '(') {
        const scan = braceDelta(signature.slice(start), newLexicalState(), lang, 0)
        return scan.matchingParenEnd === undefined ? -1 : start + scan.matchingParenEnd + 1
      }
      let depth = 0
      for (let i = start; i < signature.length; i++) {
        if (signature[i] === left) depth++
        else if (signature[i] === right && --depth === 0) return i + 1
      }
      return -1
    }
    if (signature[cursor] === '[') {
      cursor = skipBalanced(cursor, '[', ']')
      if (cursor < 0) return null
    }
    while (signature[cursor] === '(') {
      cursor = skipBalanced(cursor, '(', ')')
      if (cursor < 0) return null
      while (/\s/.test(signature[cursor] ?? '')) cursor++
    }
    while (/\s/.test(signature[cursor] ?? '')) cursor++
    if (signature[cursor] !== ':') return null
    returnType = signature.slice(cursor + 1)
    open = '['
    close = ']'
  } else {
    return null
  }

  if (lang.name === 'scala') {
    const state = newLexicalState()
    braceDelta(returnType, state, lang)
    return state.bracketDepth > 0 ? 'incomplete' : 'complete'
  }

  let depth = 0
  let found = false
  for (const character of returnType) {
    if (character === open) {
      depth++
      found = true
    } else if (character === close && depth > 0) {
      depth--
    }
  }
  if (!found) return null
  return depth > 0 ? 'incomplete' : 'complete'
}

function rubyEndlessMethodParameterClose(codeWithoutLiterals: string): number | null {
  const headers = [
    /^\s*def\s+(?:(?:[\p{ID_Start}_][\p{ID_Continue}]*(?:::|\.)\s*)*)[\p{ID_Start}_][\p{ID_Continue}]*[!?]?\s*\(/u,
    /^\s*def\s+(?:(?:[\p{ID_Start}_][\p{ID_Continue}]*(?:::|\.)\s*)*)[\p{ID_Start}_][\p{ID_Continue}]*=\s*\(/u,
    /^\s*def\s+(?:\[\]|<=>|===|==|=~|!~|!=|<=|>=|<<|>>|\*\*|[+\-*\/%&|^~<>!])\s*\(/,
  ]
  const header = headers.map((pattern) => codeWithoutLiterals.match(pattern)?.[0]).find((match) => match !== undefined)
  if (header === undefined) return null

  let depth = 0
  for (let i = header.length - 1; i < codeWithoutLiterals.length; i++) {
    if (codeWithoutLiterals[i] === '(') depth++
    else if (codeWithoutLiterals[i] === ')' && --depth === 0) return i
  }
  return null
}

function isRubyEndlessMethod(code: string): boolean {
  const codeWithoutLiterals = rubyCodeWithoutLiterals(code, newLexicalState())
  if (/^\s*def\s+(?:self\.)?[\p{ID_Start}_][\p{ID_Continue}]*[!?]?\s+=\s*(?:\S|$)/u.test(codeWithoutLiterals)) return true
  const receiverMethod = codeWithoutLiterals.match(/^\s*def\s+([^\s(]+)\s+=\s*(?:\S|$)/)
  if (receiverMethod?.[1]?.includes('.')) return true
  const parameterClose = rubyEndlessMethodParameterClose(codeWithoutLiterals)
  return parameterClose !== null && /^\s*=\s*(?:\S|$)/.test(codeWithoutLiterals.slice(parameterClose + 1))
}

function rubyEndlessMethodParameters(code: string): Set<string> {
  return rubyEndlessMethodParameterClose(code) === null
    ? new Set()
    : rubyMethodParameterNames(code)
}

function rubyExpressionContinues(line: string, lang: LanguageDef, knownLocals: ReadonlySet<string>): boolean {
  if (lineEndsWithContinuationOperator(line, lang)) return true
  if (rubyHeredocOpeners(line, knownLocals).length > 0) return true
  const state = newLexicalState()
  const code = rubyCodeWithoutLiterals(line, state)
  const scan = braceDelta(code, state, lang)
  return scan.balance > 0
    || state.parenDepth > 0
    || state.bracketDepth > 0
    || state.rubyQuote !== null
    || state.rubyDelimited !== null
    || rubyBlockOpenerCount(code) - (code.match(/(?<![:\w@$])end\b(?!:)/g)?.length ?? 0)
      - code.split(';').filter((statement) => isRubyEndlessMethod(statement.trim())).length > 0
}

function rubyEndlessMethodContinues(line: string, lang: LanguageDef): boolean {
  return isRubyEndlessMethod(line.trim())
    && rubyExpressionContinues(line, lang, rubyEndlessMethodParameters(line))
}

function symbolEndsOnLine(
  line: string,
  lang: LanguageDef | null,
  opensBrace: boolean,
  nextCodeLine?: string,
): boolean {
  if (!lang) return false
  const trimmed = line.trim()
  const code = lang.name === 'python' ? stripPythonComment(line).trim() : trimmed
  if (lang.name === 'python' && /^(?:async\s+)?(?:def|class)\b/.test(code)) {
    const header = scanPythonHeader(line)
    return header.topLevelColonIndex !== null
      && stripPythonComment(line).slice(header.topLevelColonIndex + 1).trim().length > 0
  }
  if (lang.name === 'ruby' && /^(?:class|module|def)\b.*;\s*end$/.test(trimmed)) {
    return rubyBlockDelta(line, newLexicalState(), lang).delta === 0
  }
  if (lang.name === 'ruby' && isRubyEndlessMethod(trimmed)) return !rubyEndlessMethodContinues(line, lang)
  if (lang.name === 'ruby' && /^(?:class|module|def)\b/.test(trimmed)) return false
  if (opensBrace) return false
  if (isBodylessDeclaration(code, lang)) return true
  const commentStrippedLine = lang.name === 'python' ? code : stripInlineComments(line, lang).trim()
  if (commentStrippedLine.endsWith(';')) return true
  if (hasIncompleteExpression(line, lang, nextCodeLine)) return false
  if (lang.name === 'javascript' || lang.name === 'typescript') {
    return false
  }
  if (lang.name === 'kotlin') return hasKotlinExpressionBody(line) && /\bfun\b.*=\s*\S/.test(code)
  if (lang.name === 'scala') {
    const bodyEquals = scalaExpressionBodyEquals(code, lang)
    return bodyEquals !== null && code.slice(bodyEquals + 1).trim().length > 0
  }
  return false
}

function isBodylessDeclaration(line: string, lang: LanguageDef): boolean {
  const code = stripInlineComments(line, lang).trim()
  if (/[{}]/.test(code)) return false
  if (lang.name === 'go') {
    if (!/^func\b/.test(code)) return false
    const functionStart = code.search(/\bfunc\b/)
    const parameterStart = code.indexOf('(', functionStart)
    if (parameterStart < 0) return false
    const resultType = functionParameterSuffix(code, parameterStart, lang)
    return resultType !== null && (resultType.length === 0 || /^(?:\w|\*|\[|\(|<)/.test(resultType))
  }
  if (lang.name === 'swift') {
    const functionStart = code.search(/\bfunc\b/)
    const parameterStart = functionStart < 0 ? -1 : code.indexOf('(', functionStart)
    if (parameterStart < 0) return false
    let depth = 0
    for (let i = parameterStart; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')' && --depth === 0) return true
    }
    return false
  }
  if (lang.name === 'kotlin') {
    if (/=/.test(code)) return false
    return /\bfun\b.*\)\s*(?::\s*[^=]+)?(?:\s+where\b.*)?$/.test(code)
  }
  if (lang.name === 'scala') {
    if (/^(?:(?:private|protected|final|sealed|abstract|case|open)\s+)*(?:class|object|trait|enum)\b/.test(code)) {
      if (code.endsWith(':') || /\b(?:extends|with|derives)\s*$/.test(code)) return false
      const state = newLexicalState()
      braceDelta(code, state, lang)
      return state.parenDepth === 0 && state.bracketDepth === 0 && state.quote === null
    }
    if (scalaExpressionBodyEquals(code, lang) !== null) return false
    return /\bdef\b.*(?:\)\s*(?::\s*[^=]+)?|:\s*[^=]+)$/.test(code)
  }
  return false
}

function lineEndsWithContinuationOperator(line: string, lang: LanguageDef | null, initialBlockCommentDepth = 0): boolean {
  if (!lang || !['javascript', 'typescript', 'kotlin', 'scala', 'ruby'].includes(lang.name)) return false
  const code = (lang.name === 'ruby'
    ? rubyCodeWithoutLiterals(line, newLexicalState())
    : stripInlineComments(line, lang, initialBlockCommentDepth)).trimEnd()
  if (lang.name === 'ruby' && code.endsWith('\\')) return true
  if (lang.name === 'ruby' && code.endsWith('?') && !/\s\?$/.test(code)) return false
  if (lang.name === 'scala' && /\b(?:match|do)$/.test(code)) return true
  if ((lang.name === 'kotlin' || lang.name === 'scala') && hasIncompleteIfExpression(line, lang)) return true
  if (!/(?:=>|[|&=+\-*\/%?:.,<>])$/.test(code)) return false
  if ((lang.name === 'javascript' || lang.name === 'typescript') && code.endsWith('/')) {
    const state = newLexicalState()
    braceDelta(code, state, lang)
    return state.canStartRegex
  }
  return true
}

function stripInlineComments(line: string, lang: LanguageDef, initialBlockCommentDepth = 0): string {
  let code = ''
  let quote: QuoteKind = null
  let quoteLength: 0 | 1 | 3 = 0
  let escaped = false
  let blockCommentDepth = initialBlockCommentDepth
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (blockCommentDepth > 0) {
      code += ' '
      if (supportsNestedBlockComments(lang) && ch === '/' && line[i + 1] === '*') {
        blockCommentDepth++
        code += ' '
        i++
      } else if (ch === '*' && line[i + 1] === '/') {
        blockCommentDepth--
        code += ' '
        i++
      }
      continue
    }
    if (quote !== null) {
      code += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (quoteLength === 3 && line.startsWith(quote.repeat(3), i)) {
        code += line.slice(i + 1, i + 3)
        i += 2
        quote = null
        quoteLength = 0
      } else if (quoteLength === 1 && ch === quote) {
        quote = null
        quoteLength = 0
      }
      continue
    }
    const scalaSymbolLength = scalaSymbolLiteralLength(line, i, lang)
    if (scalaSymbolLength > 0) {
      code += line.slice(i, i + scalaSymbolLength)
      i += scalaSymbolLength - 1
      continue
    }
    if (ch === '/' && line[i + 1] === '/' && lang.commentPrefixes.includes('//')) {
      if (
        (lang.name !== 'javascript' && lang.name !== 'typescript')
        || !isInsideJavaScriptRegex(line, i, lang)
      ) break
    }
    if (ch === '/' && line[i + 1] === '*' && lang.commentPrefixes.includes('/*')) {
      if (
        (lang.name !== 'javascript' && lang.name !== 'typescript')
        || !isInsideJavaScriptRegex(line, i, lang)
      ) {
        blockCommentDepth = 1
        code += '  '
        i++
        continue
      }
    }
    if (ch === '#' && lang.name === 'php') break
    if (ch === '"' || ch === "'") {
      quote = ch
      quoteLength = quoteDelimiterLength(line, i, ch, lang)
      code += line.slice(i, i + quoteLength)
      i += quoteLength - 1
      continue
    }
    if (ch === '`' && (lang.name === 'javascript' || lang.name === 'typescript')) {
      quote = '`'
      quoteLength = 1
    }
    code += ch
  }
  return code
}

function isObjectiveCPreprocessorDirective(lines: readonly string[], lineIndex: number, lang: LanguageDef): boolean {
  let directiveLine = lineIndex
  while (directiveLine > 0 && lines[directiveLine - 1]!.trimEnd().endsWith('\\')) directiveLine--
  return skipLeadingBlockComments(lines[directiveLine]!, lang).trimStart().startsWith('#')
}

function objectiveCEndsScope(
  line: string,
  initialBlockCommentDepth = 0,
  initialQuote: QuoteKind = null,
  initialEscaped = false,
): boolean {
  let quote = initialQuote
  let escaped = initialEscaped
  let blockCommentDepth = initialBlockCommentDepth
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (blockCommentDepth > 0) {
      if (ch === '*' && line[i + 1] === '/') {
        blockCommentDepth--
        i++
      }
      continue
    }
    if (quote !== null) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && line[i + 1] === '/') break
    if (ch === '/' && line[i + 1] === '*') {
      blockCommentDepth = 1
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (
      line.startsWith('@end', i)
      && (i === 0 || !/[\w$]/.test(line[i - 1]!))
      && !/[\w$]/.test(line[i + 4] ?? '')
    ) return true
  }
  return false
}

function functionParameterSuffix(line: string, parameterStart: number, lang: LanguageDef): string | null {
  const scan = braceDelta(line.slice(parameterStart), newLexicalState(), lang, 0)
  if (scan.matchingParenEnd === undefined) return null
  return stripInlineComments(line.slice(parameterStart + scan.matchingParenEnd + 1), lang).trimStart()
}

function typeScriptFunctionParameterStart(code: string, functionStart: number): number {
  let cursor = functionStart + 'function'.length
  if (code[cursor] === '*') cursor++
  while (/\s/.test(code[cursor] ?? '')) cursor++
  const name = code.slice(cursor).match(/^[\p{ID_Start}_$][\p{ID_Continue}$]*/u)?.[0]
  if (name !== undefined) cursor += name.length
  while (/\s/.test(code[cursor] ?? '')) cursor++
  if (code[cursor] !== '<') return code[cursor] === '(' ? cursor : -1

  let depth = 0
  let quote: "'" | '"' | '`' | null = null
  let escaped = false
  for (let i = cursor; i < code.length; i++) {
    const ch = code[i]!
    if (quote !== null) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    } else if (ch === '<') {
      depth++
    } else if (ch === '>' && code[i - 1] !== '=') {
      depth--
      if (depth === 0) {
        cursor = i + 1
        while (/\s/.test(code[cursor] ?? '')) cursor++
        return code[cursor] === '(' ? cursor : -1
      }
    }
  }
  return -1
}

function typeScriptObjectReturnSuffix(suffix: string, lang: LanguageDef): string | null {
  const returnType = suffix.trimStart()
  if (!returnType.startsWith(':')) return null
  const objectType = returnType.slice(1).trimStart()
  if (objectType.startsWith('{')) {
    const scan = braceDelta(objectType, newLexicalState(), lang, undefined, 0)
    if (scan.matchingBraceEnd === undefined) return null
    return objectType.slice(scan.matchingBraceEnd + 1).trimStart()
  }
  let genericDepth = 0
  let parenDepth = 0
  let bracketDepth = 0
  let quote: "'" | '"' | '`' | null = null
  let escaped = false
  let objectBranchSuffix: string | null = null
  for (let i = 0; i < objectType.length; i++) {
    const ch = objectType[i]!
    if (quote !== null) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '<') genericDepth++
    else if (ch === '>' && objectType[i - 1] !== '=') genericDepth = Math.max(0, genericDepth - 1)
    else if (ch === '(') parenDepth++
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (ch === '[') bracketDepth++
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (
      (ch === '?' || ch === ':')
      && genericDepth === 0
      && parenDepth === 0
      && bracketDepth === 0
    ) {
      let objectStart = i + 1
      while (/\s/.test(objectType[objectStart] ?? '')) objectStart++
      if (objectType[objectStart] === '{') {
        const scan = braceDelta(objectType.slice(objectStart), newLexicalState(), lang, undefined, 0)
        if (scan.matchingBraceEnd === undefined) return null
        const objectEnd = objectStart + scan.matchingBraceEnd
        objectBranchSuffix = objectType.slice(objectEnd + 1).trimStart()
        i = objectEnd
      }
    }
    else if (
      (ch === '|' || ch === '&')
      && genericDepth === 0
      && parenDepth === 0
      && bracketDepth === 0
    ) {
      let objectStart = i + 1
      while (/\s/.test(objectType[objectStart] ?? '')) objectStart++
      if (objectType[objectStart] === '{') {
        const scan = braceDelta(objectType.slice(objectStart), newLexicalState(), lang, undefined, 0)
        if (scan.matchingBraceEnd === undefined) return null
        const objectEnd = objectStart + scan.matchingBraceEnd
        objectBranchSuffix = objectType.slice(objectEnd + 1).trimStart()
        i = objectEnd
      }
    }
  }
  if (objectBranchSuffix !== null) return objectBranchSuffix
  const genericStart = objectType.indexOf('<')
  if (genericStart < 0 || !objectType.slice(genericStart).includes('{')) return null
  let typeArgumentDepth = 0
  for (let i = genericStart; i < objectType.length; i++) {
    if (objectType[i] === '<') {
      typeArgumentDepth++
    } else if (objectType[i] === '>' && objectType[i - 1] !== '=' && --typeArgumentDepth === 0) {
      return objectType.slice(i + 1).trimStart()
    }
  }
  return null
}

function isSplitAmbientTypeScriptFunction(line: string, lang: LanguageDef | null): boolean {
  if (lang?.name !== 'typescript') return false
  const code = stripInlineComments(line, lang).trim()
  return /^(?:export\s+)?declare\s+function\b/.test(code)
    && !code.includes('(')
    && !/[;{}]/.test(code)
}

function hasIncompleteTypeScriptReturnType(signature: string, lang: LanguageDef): boolean {
  const functionStart = signature.search(/\bfunction\b/)
  const parameterStart = functionStart < 0 ? -1 : typeScriptFunctionParameterStart(signature, functionStart)
  if (parameterStart < 0) return false
  const suffix = functionParameterSuffix(signature, parameterStart, lang)
  if (suffix === null || !suffix.trimStart().startsWith(':')) return false

  let depth = 0
  let quote: "'" | '"' | '`' | null = null
  let escaped = false
  for (let i = 0; i < suffix.length; i++) {
    const ch = suffix[i]!
    if (quote !== null) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    } else if (ch === '<') {
      depth++
    } else if (ch === '>' && suffix[i - 1] !== '=') {
      depth = Math.max(0, depth - 1)
    }
  }
  return depth > 0 || /[|&]\s*$/.test(suffix)
}

function hasIncompleteFunctionParameters(line: string, lang: LanguageDef): boolean {
  const code = stripInlineComments(line, lang)
  const functionKeyword = lang.name === 'go' || lang.name === 'swift'
    ? /\bfunc\b/
    : lang.name === 'rust'
      ? /\bfn\b/
      : lang.name === 'kotlin'
        ? /\bfun\b/
        : lang.name === 'scala'
          ? /\bdef\b/
          : /\bfunction\b/
  const functionStart = code.search(functionKeyword)
  let parameterStart = functionStart < 0
    ? -1
    : lang.name === 'typescript'
      ? typeScriptFunctionParameterStart(code, functionStart)
      : lang.name === 'kotlin'
        ? kotlinFunctionParameterStart(code, functionStart)
      : code.indexOf('(', functionStart)
  if (lang.name === 'go' && functionStart >= 0) {
    const afterKeyword = code.slice(functionStart + 'func'.length)
    const firstNonWhitespace = afterKeyword.search(/\S/)
    if (firstNonWhitespace >= 0 && afterKeyword[firstNonWhitespace] === '(') {
      const receiverStart = functionStart + 'func'.length + firstNonWhitespace
      const receiver = braceDelta(code.slice(receiverStart), newLexicalState(), lang)
      if (receiver.matchingParenEnd === undefined) return true
      parameterStart = code.indexOf('(', receiverStart + receiver.matchingParenEnd + 1)
    }
  }
  if (parameterStart < 0) return false
  return functionParameterSuffix(line, parameterStart, lang) === null
}

function hasPendingTypeScriptObjectReturn(line: string, lang: LanguageDef): boolean {
  const code = stripInlineComments(line, lang)
  const functionStart = code.search(/\bfunction\b/)
  const parameterStart = functionStart < 0 ? -1 : typeScriptFunctionParameterStart(code, functionStart)
  if (parameterStart < 0) return false
  const suffix = functionParameterSuffix(line, parameterStart, lang)
  if (suffix === null) return false
  const annotation = suffix.trimStart()
  if (!annotation.startsWith(':')) return false
  const objectType = annotation.slice(1).trimStart()
  if (objectType.length === 0) return true
  const genericObjectType = objectType.includes('<') && objectType.includes('{')
  const unionObjectType = /(?:^|[|&])\s*\{/.test(objectType)
  const conditionalObjectType = /\bextends\b[\s\S]*?(?:\?|:)\s*\{/.test(objectType)
  if (!objectType.startsWith('{') && !genericObjectType && !unionObjectType && !conditionalObjectType) return false
  const objectReturnSuffix = typeScriptObjectReturnSuffix(annotation, lang)
  return objectReturnSuffix === null || objectReturnSuffix === ''
}

function hasSplitTypeScriptObjectReturn(
  lines: readonly string[],
  lineIndex: number,
  line: string,
  lang: LanguageDef | null,
): boolean {
  if (lang?.name !== 'typescript') return false
  const code = stripInlineComments(line, lang)
  const functionStart = code.search(/\bfunction\b/)
  const parameterStart = functionStart < 0 ? -1 : typeScriptFunctionParameterStart(code, functionStart)
  if (parameterStart < 0) return false
  const initialSuffix = functionParameterSuffix(line, parameterStart, lang)
  if (initialSuffix === null) return false

  let signature = line
  for (let nextIndex = lineIndex + 1; nextIndex < lines.length; nextIndex++) {
    const typeLine = lines[nextIndex]!
    const typeCode = stripInlineComments(typeLine, lang).trim()
    if (typeCode.length === 0) continue
    signature += `\n${typeLine}`
    const suffix = functionParameterSuffix(signature, parameterStart, lang)
    if (suffix === null) return false
    const annotation = suffix.trimStart()
    if (!annotation.startsWith(':')) return false
    const objectType = annotation.slice(1).trimStart()
    if (
      objectType.startsWith('{')
      || (objectType.includes('<') && objectType.includes('{'))
      || /(?:^|[|&])\s*\{/.test(objectType)
      || (/\bextends\b[\s\S]*?(?:\?|:)\s*\{/.test(objectType))
    ) return true
    const conditionalQuestion = objectType.indexOf('?')
    if (
      conditionalQuestion >= 0
      && /\bextends\b/.test(objectType)
      && !objectType.slice(conditionalQuestion + 1).includes(':')
    ) continue
    if (objectType.length === 0 || /[<|&]\s*$/.test(objectType)) continue
    return false
  }
  return false
}

function expressionSymbol(line: string, lang: LanguageDef | null): boolean {
  if (!lang) return false
  const trimmed = line.trim()
  if (lang.name === 'javascript' || lang.name === 'typescript') {
    return hasArrowExpression(line, lang)
      || /^\s*(?:export\s+)?(?:declare\s+)?type\b.*=/.test(trimmed)
      || hasIncompleteExpression(line, lang)
  }
  if (lang.name === 'kotlin') return hasKotlinExpressionBody(line) || hasIncompleteExpression(line, lang)
  if (lang.name === 'scala') {
    const bodyEquals = scalaExpressionBodyEquals(line, lang)
    return (bodyEquals !== null && line.slice(bodyEquals + 1).trim().length === 0) || hasIncompleteExpression(line, lang)
  }
  return false
}

function expressionBodyStartsOnLine(line: string, lang: LanguageDef | null): boolean {
  if (lang?.name === 'ruby') return rubyEndlessMethodContinues(line, lang)
  if (lang?.name === 'javascript' || lang?.name === 'typescript') {
    return hasArrowExpression(line, lang) && /=>\s*\S/.test(line)
      || /^\s*(?:export\s+)?(?:declare\s+)?type\b.*=\s*\S/.test(line)
  }
  if (lang?.name === 'kotlin') return hasKotlinExpressionBody(line) && /\bfun\b.*=\s*\S/.test(line)
  if (lang?.name === 'scala') {
    const bodyEquals = scalaExpressionBodyEquals(line, lang)
    return bodyEquals !== null && line.slice(bodyEquals + 1).trim().length > 0
  }
  return false
}

function hasArrowExpression(line: string, lang: LanguageDef): boolean {
  const isTypeScriptFunctionDeclaration = lang.name === 'typescript'
    && /^(?:export(?:\s+default)?\s+)?(?:declare\s+)?(?:async\s+)?function\b/.test(line.trim())
  return !isTypeScriptFunctionDeclaration && /=>/.test(line)
}

function maskQuotedBraces(code: string): string {
  let quote: QuoteKind = null
  let escaped = false
  let masked = ''
  for (const character of code) {
    if (quote !== null) {
      masked += character === '{' || character === '}' ? ' ' : character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
    } else {
      masked += character
      if (character === '"' || character === "'" || character === '`') {
        quote = character
        escaped = false
      }
    }
  }
  return masked
}

function symbolBraceOpensBody(line: string, lang: LanguageDef | null, opensBrace: boolean): boolean {
  if (!opensBrace) return false
  if (!lang || !['javascript', 'typescript', 'kotlin', 'swift'].includes(lang.name)) return true
  const code = stripInlineComments(line, lang)
  const functionKeyword = lang.name === 'kotlin' ? /\bfun\b/ : lang.name === 'swift' ? /\bfunc\b/ : /\bfunction\b/
  const functionStart = code.search(functionKeyword)
  if (functionStart < 0) return true
  const parameterStart = lang.name === 'typescript'
    ? typeScriptFunctionParameterStart(code, functionStart)
    : lang.name === 'kotlin'
      ? kotlinFunctionParameterStart(code, functionStart)
    : code.indexOf('(', functionStart)
  if (parameterStart < 0) {
    const signature = code.slice(functionStart)
    const hasTypeScriptGenericParameters = lang.name === 'typescript'
      && /^function\s*\*?\s*[\w$]+\s*</.test(signature)
    return !hasTypeScriptGenericParameters
  }
  if (lang.name === 'javascript' || lang.name === 'typescript') {
    const suffix = functionParameterSuffix(line, parameterStart, lang)
    if (suffix === null) return false
    if (lang.name === 'javascript') return /^\s*\{/.test(suffix)
    const objectReturnSuffix = typeScriptObjectReturnSuffix(suffix, lang)
    if (objectReturnSuffix !== null) {
      return /^\s*\{/.test(objectReturnSuffix)
        || /^(?:\s*[|&]\s*[A-Za-z_$][\w$.[\]<>?, ]*)*\s*\{/.test(objectReturnSuffix)
        || (/\bextends\b[\s\S]*\?[\s\S]*:\s*[^{}]+\{\s*$/.test(suffix))
    }
    return /^\s*(?::\s*[^{}]+)?\s*\{/.test(maskQuotedBraces(suffix))
  }
  let depth = 0
  let quote: "'" | '"' | null = null
  let escaped = false
  for (let i = parameterStart; i < code.length; i++) {
    const ch = code[i]!
    if (quote !== null) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
      if (depth === 0) {
        const suffix = code.slice(i + 1)
        if (lang.name === 'kotlin') return /\{/.test(suffix)
        return /\{/.test(suffix)
      }
    }
  }
  return false
}

function startsJavaScriptArrowParameters(source: string, lang: LanguageDef): boolean {
  const identifier = source.match(/^[_$\p{ID_Start}][_$\p{ID_Continue}]*/u)
  if (identifier !== null && source.slice(identifier[0].length).trimStart().startsWith('=>')) return true
  if (!source.startsWith('(')) return false
  const scan = braceDelta(source, newLexicalState(), lang, 0)
  return scan.matchingParenEnd !== undefined
    && source.slice(scan.matchingParenEnd + 1).trimStart().startsWith('=>')
}

function isTopLevelStatementStart(
  line: string,
  lang: LanguageDef | null,
  initialBlockCommentDepth = 0,
  previousLine?: string,
): boolean {
  if (!lang) return false
  const trimmed = stripInlineComments(line, lang, initialBlockCommentDepth).trim()
  if (trimmed.length === 0 || isCommentLine(line, lang, initialBlockCommentDepth)) return false
  const startsAssignment = /^[_$\p{ID_Start}][_$\p{ID_Continue}]*(?:(?:\s*(?:\.|\?\.)\s*[_$\p{ID_Start}][_$\p{ID_Continue}]*)|(?:\s*\[[^\]]+\]))*\s*(?:>>>=|<<=|>>=|\*\*=|&&=|\|\|=|\?\?=|[+\-*\/%&|^]?=(?!=|>))/u.test(trimmed)
  if (lang.name === 'javascript' || lang.name === 'typescript') {
    const asyncArrowParameters = trimmed.match(/^async\s+([\s\S]+)$/)?.[1]
    return startsJavaScriptArrowParameters(trimmed, lang)
      || (asyncArrowParameters !== undefined && startsJavaScriptArrowParameters(asyncArrowParameters, lang))
      || /^(?:export\s+)?(?:(?:async\s+)?function|const|let|var|class|interface|type|enum|namespace|module|import|return|throw|break|continue|yield|void|typeof|delete|if|do|for|while|switch|case|default|try)\b/.test(trimmed)
      || /^[A-Za-z_$][\w$]*\s*:\s*\S/.test(trimmed)
      || /^export\s+default\b/.test(trimmed)
      || /^export\s+(?:\{|\*)/.test(trimmed)
      || (lang.name === 'typescript' && /^(?:export\s+)?declare\b/.test(trimmed))
      || (lang.name === 'typescript' && /^using\s+\S/.test(trimmed))
      || trimmed.startsWith('@')
      || /^await\s+\S/.test(trimmed)
      || trimmed.startsWith('{')
      || /^(?:\d(?:_?\d)*\.(?:\d(?:_?\d)*)?|\.\d(?:_?\d)*)/.test(trimmed)
      || /^(?:await\s+)?new\s+[\w$]+(?:\s*(?:\.|\?\.)\s*[\w$]+)*$/.test(trimmed)
      || (lang.name === 'typescript'
        && /^(?:await\s+)?new\s+[\w$]+(?:\s*<[^;{}]+>)?(?:\s*(?:\.|\?\.)\s*[\w$]+(?:\s*<[^;{}]+>)?)*\s*\(/.test(trimmed))
      || /^(?:await\s+)?(?:new\s+)?[_$\p{ID_Start}][_$\p{ID_Continue}]*(?:\s*(?:\.|\?\.)\s*[_$\p{ID_Start}][_$\p{ID_Continue}]*)*\s*\(/u.test(trimmed)
      || /^[_$\p{ID_Start}][_$\p{ID_Continue}]*(?:(?:\s*(?:\.|\?\.)\s*[_$\p{ID_Start}][_$\p{ID_Continue}]*)|(?:\s*\[[^\]]+\]))+$/u.test(trimmed)
      || /^[\w$]+(?:(?:\s*(?:\.|\?\.)\s*[\w$]+)|(?:\s*\[[^\]]+\]))*\s*\?\.\s*\(/.test(trimmed)
      || startsAssignment
      || /^[\w$]+(?:(?:\s*(?:\.|\?\.)\s*[\w$]+)|(?:\s*\[[^\]]+\]))*\s*(?:\*\*|>>>|>>|<<|<=|>=|===|!==|==|!=|&&|\|\||\?\?|[+\-*\/%&|^<>])\s*\S/.test(trimmed)
      || /^(?:\+\+|--)?[A-Za-z_$][\w$]*(?:\s*(?:\.|\?\.)\s*[A-Za-z_$][\w$]*)*\s*(?:\+\+|--)$/.test(trimmed)
      || /^(?:[!~]\s*\S|(?:\+\+|--)\s*\S)/.test(trimmed)
      || (/^[+-]\s*\S/.test(trimmed)
        && previousLine !== undefined
        && stripInlineComments(previousLine, lang).trimEnd().endsWith(';'))
      || /^["'`]/.test(trimmed)
      || /^;\s*\S/.test(trimmed)
      || /;\s*$/.test(trimmed)
      || (trimmed.startsWith('/') && isInsideJavaScriptRegex(trimmed, 1, lang))
      || (/^\[/.test(trimmed) && previousLine !== undefined && stripInlineComments(previousLine, lang).trimEnd().endsWith(';'))
      || /^[\w$]+(?:\s*(?:\?\.|\.)\s*[\w$]+)*\s*`/.test(trimmed)
      || /^[\w$]+$/.test(trimmed)
  }
  if (lang.name === 'kotlin') {
    return isKotlinAnnotationLine(trimmed)
      || /^(?:(?:public|private|protected|internal|open|abstract|sealed|data|inline|suspend)\s+)*(?:val|var|fun|class|interface|enum|object|typealias|import|package)\b/.test(trimmed)
      || /^(?:return|throw|break|continue)\b/.test(trimmed)
      || /^when\b/.test(trimmed)
      || /^[A-Za-z_$][\w$]*@\s*(?:while|for|do)\b/.test(trimmed)
      || /^try\b/.test(trimmed)
      || /^do\b/.test(trimmed)
      || /^["']/.test(trimmed)
      || /^[!+-]\s*\S/.test(trimmed)
      || (trimmed.startsWith('(')
        && previousLine !== undefined
        && stripInlineComments(previousLine, lang).trimEnd().endsWith(';'))
      || /^(?:\d|true\b|false\b|null\b)/.test(trimmed)
      || (trimmed !== 'else' && /^[\w$]+(?:\s*(?:\?\.|\.)\s*[\w$]+)*$/.test(trimmed))
      || /^[\w$]+(?:\s*(?:\?\.|\.)\s*[\w$]+)*\s*\{/.test(trimmed)
      || /^[_$\p{ID_Start}][_$\p{ID_Continue}]*(?:\s*(?:\?\.|\.)\s*[_$\p{ID_Start}][_$\p{ID_Continue}]*)*\s*\(/u.test(trimmed)
      || /^(?:\+\+|--)?[A-Za-z_$][\w$]*(?:\s*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\]))*\s*(?:\+\+|--)$/.test(trimmed)
      || IDENTIFIER_LED_BINARY_RE.test(trimmed)
      || startsAssignment
  }
  if (lang.name === 'scala') {
    return /^(?:(?:private|protected|implicit|final|sealed|abstract|override|lazy)\s+)*(?:val|var|def|class|object|trait|enum|type|given|import|package)\b/.test(trimmed)
      || /^(?:return|throw|if|for|while|try)\b/.test(trimmed)
      || /\bmatch\s*(?:\{\s*)?$/.test(trimmed)
      || /^["']/.test(trimmed)
      || /^new\s+\S/.test(trimmed)
      || /^(?:0[xX][\da-fA-F_]+[lL]?|0[bB][01_]+[lL]?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?(?:[fFdDlL])?)$/.test(trimmed)
      || /^[!+-]\s*\S/.test(trimmed)
      || (trimmed.startsWith('(')
        && previousLine !== undefined
        && stripInlineComments(previousLine, lang).trimEnd().endsWith(';'))
      || (trimmed !== 'else' && /^[$_\p{ID_Start}][$\p{ID_Continue}]*(?:\s*\.\s*[$_\p{ID_Start}][$\p{ID_Continue}]*)*$/u.test(trimmed))
      || /^[$_\p{ID_Start}][$\p{ID_Continue}]*(?:\s*\.\s*[$_\p{ID_Start}][$\p{ID_Continue}]*)*(?:\s*\[[^\n]*\])?\s*\(/u.test(trimmed)
      || IDENTIFIER_LED_BINARY_RE.test(trimmed)
      || startsAssignment
  }
  return false
}

function symbolMode(
  line: string,
  lang: LanguageDef | null,
  opensBrace: boolean,
  nextCodeLine?: string,
): SymbolScope['mode'] {
  if (!lang) return 'persistent'
  if (lang.name === 'python') return symbolEndsOnLine(line, lang, opensBrace) ? 'line' : 'indent'
  if (lang.name === 'ruby') {
    if (rubyEndlessMethodContinues(line, lang)) return 'expression'
    if (symbolEndsOnLine(line, lang, opensBrace, nextCodeLine)) return 'line'
    return /^(?:class|module|def)\b/.test(line.trim()) ? 'ruby' : 'line'
  }
  if (lang.name === 'php' && /^namespace(?:\s+\\?[\w\\]+)?\s*;$/.test(stripInlineComments(line, lang).trim())) {
    return 'phpNamespace'
  }
  if (lang.name === 'php' && /\bfunction\b/.test(stripInlineComments(line, lang))
    && !opensBrace && !symbolEndsOnLine(line, lang, opensBrace)) return 'pending'
  if (lang.name === 'objectivec') {
    const code = stripInlineComments(line, lang).trim()
    if (/^@(interface|implementation|protocol)\b/.test(code) && !code.endsWith(';')) return 'objc'
    if (/^[-+]\s*\(/.test(code) && !opensBrace && !code.endsWith(';')) return 'pending'
  }
  if (isSplitAmbientTypeScriptFunction(line, lang)) return 'pending'
  if (!usesBraceScopes(lang)) return 'persistent'
  if (
    lang.name === 'scala'
    && /^(?:(?:private|protected|final|sealed|abstract|case|open)\s+)*(?:class|object|trait|enum)\b/.test(stripInlineComments(line, lang).trim())
    && stripInlineComments(line, lang).trimEnd().endsWith(':')
  ) return 'indent'

  if (['javascript', 'typescript', 'go', 'swift', 'rust', 'kotlin', 'scala'].includes(lang.name)
    && hasIncompleteFunctionParameters(line, lang)) return 'pending'
  if (lang.name === 'scala' && isScalaRefinementHeader(line, lang)) return 'pending'
  if ((lang.name === 'kotlin' || lang.name === 'scala')
    && genericReturnTypeStatus(line, lang) === 'incomplete') return 'pending'
  if (
    lang.name === 'kotlin'
    && !opensBrace
    && /^(?:(?:public|private|protected|internal|open|abstract|sealed|data)\s+)*class\b/.test(stripInlineComments(line, lang).trim())
  ) return 'pending'
  if (lang.name === 'rust' && /\bfn\b/.test(stripInlineComments(line, lang)) && !opensBrace) return 'pending'
  if (lang.name === 'typescript' && hasPendingTypeScriptObjectReturn(line, lang)) return 'pending'
  if (
    (lang.name === 'kotlin' || lang.name === 'swift') && !opensBrace
    && (isBodylessDeclaration(line, lang)
      || (lang.name === 'kotlin' && hasKotlinDefaultParameter(line) && !hasKotlinExpressionBody(line)))
  ) return 'pending'
  if (lang.name === 'scala' && isBodylessDeclaration(line, lang)) return 'pending'
  if (symbolEndsOnLine(line, lang, opensBrace, nextCodeLine)) return 'line'
  if (expressionSymbol(line, lang)) return 'expression'
  return 'brace'
}

function isBodylessTypeScriptFunction(
  lines: readonly string[],
  lineIndex: number,
  line: string,
  opensBody: boolean,
  lang: LanguageDef | null,
): boolean {
  if (lang?.name !== 'typescript' || opensBody) return false
  const code = stripInlineComments(line, lang).trim()
  if (!/^(?:export(?:\s+default)?\s+)?(?:declare\s+)?(?:async\s+)?function\b/.test(code)) return false
  const functionStart = code.search(/\bfunction\b/)
  const parameterStart = typeScriptFunctionParameterStart(code, functionStart)
  if (parameterStart < 0 || functionParameterSuffix(line, parameterStart, lang) === null) return false
  if (code.endsWith(':')) return false
  if (/\bdeclare\b/.test(code) && !hasIncompleteTypeScriptReturnType(line, lang)) return true
  for (let nextIndex = lineIndex + 1; nextIndex < lines.length; nextIndex++) {
    const nextCode = stripInlineComments(lines[nextIndex]!, lang).trim()
    if (nextCode.length === 0) continue
    if (nextCode.startsWith(':') || nextCode.startsWith('?')) {
      let signature = line
      for (let typeIndex = nextIndex; typeIndex < lines.length; typeIndex++) {
        const typeLine = lines[typeIndex]!
        const typeCode = stripInlineComments(typeLine, lang).trim()
        if (typeCode.length === 0) continue
        signature += `\n${typeLine}`
        const signatureScan = braceDelta(signature, newLexicalState(), lang)
        if (signatureScan.opens && symbolBraceOpensBody(signature, lang, true)) return false
        if (/;\s*$/.test(typeCode)) return true
        if (
          signatureScan.balance <= 0
          && /^(?:export|declare|async|function|const|let|var|class|interface|type|namespace|module|import)\b/.test(typeCode)
        ) return true
      }
      return true
    }
    return !nextCode.startsWith('{')
  }
  return true
}

function addIndentColumns(indent: number, whitespace: string, tabWidth: number): number {
  for (const character of whitespace) {
    indent += character === '\t' ? tabWidth - (indent % tabWidth) : 1
  }
  return indent
}

function leadingIndent(line: string, tabWidth = 4): number {
  const prefix = line.match(/^[ \t]*/)?.[0] ?? ''
  return addIndentColumns(0, prefix, tabWidth)
}

function rubyParameterNames(parameters: string): Set<string> {
  const names = new Set<string>()
  let start = 0
  let depth = 0
  const add = (parameter: string): void => {
    const trimmed = parameter.trim()
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      for (const name of rubyParameterNames(trimmed.slice(1, -1))) names.add(name)
      return
    }
    const name = trimmed.match(/^(?:\*{1,2}|&)?([_\p{ID_Start}][_\p{ID_Continue}]*)/u)?.[1]
    if (name !== undefined) names.add(name)
  }
  for (let i = 0; i < parameters.length; i++) {
    const ch = parameters[i]!
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
    else if ((ch === ',' || ch === ';') && depth === 0) {
      add(parameters.slice(start, i))
      start = i + 1
    }
  }
  add(parameters.slice(start))
  return names
}

function rubyBlockParameterClose(parameters: string, start: number): number | null {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  for (let i = start; i < parameters.length; i++) {
    const ch = parameters[i]!
    if (ch === '(') parenDepth++
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (ch === '[') bracketDepth++
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (ch === '{') braceDepth++
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (ch === '|' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (parameters[i + 1] === '|') {
        i++
        continue
      }
      if (parameters[i - 1] === '|') continue
      return i
    }
  }
  return null
}

function rubyMethodParameterNames(code: string): Set<string> {
  const methodStart = code.search(/^\s*def\b/)
  const parameterStart = rubyMethodParameterStart(code)
  if (parameterStart < 0) {
    const bareParameters = code.slice(methodStart).match(/^\s*def\s+\S+\s+([\s\S]+?)\s*$/)?.[1]
    return bareParameters === undefined ? new Set() : rubyParameterNames(bareParameters)
  }
  const parameterClose = rubyMethodParameterClose(code)
  return parameterClose === null
    ? new Set()
    : rubyParameterNames(code.slice(parameterStart + 1, parameterClose))
}

function rubyBareMethodParameters(code: string): string | null {
  const methodStart = code.search(/^\s*def\b/)
  if (methodStart < 0) return null
  const methodName = code.slice(methodStart).match(
    /^\s*def\s+(?:(?:[\p{ID_Start}_][\p{ID_Continue}]*(?:::|\.)\s*)*)(?:[\p{ID_Start}_][\p{ID_Continue}]*[!?=]?|\[\]=?|[!%&*+\-/<=>^|~]+)/u,
  )
  if (methodName === null) return null
  let parameterStart = methodStart + methodName[0].length
  while (/\s/.test(code[parameterStart] ?? '')) parameterStart++
  if (code[parameterStart] === '(' || code[parameterStart] === '=' || parameterStart >= code.length) return null
  return code.slice(parameterStart)
}

function rubyMethodParametersComplete(code: string): boolean {
  const parameterStart = rubyMethodParameterStart(code)
  if (parameterStart >= 0) return rubyMethodParameterClose(code) !== null
  const bareParameters = rubyBareMethodParameters(code)
  return bareParameters !== null && !/,\s*$/.test(bareParameters)
}

function rubyMethodParametersIncomplete(code: string): boolean {
  const parameterStart = rubyMethodParameterStart(code)
  if (parameterStart >= 0) return rubyMethodParameterClose(code) === null
  const bareParameters = rubyBareMethodParameters(code)
  return bareParameters !== null && /,\s*$/.test(bareParameters)
}

function rubyMethodParameterStart(code: string): number {
  const methodStart = code.search(/^\s*def\b/)
  if (methodStart < 0) return -1
  const methodName = code.slice(methodStart).match(
    /^\s*def\s+(?:(?:[\p{ID_Start}_][\p{ID_Continue}]*(?:::|\.)\s*)*)(?:[\p{ID_Start}_][\p{ID_Continue}]*[!?=]?|\[\]=?|[!%&*+\-/<=>^|~]+)/u,
  )
  if (methodName === null) return -1
  let parameterStart = methodStart + methodName[0].length
  while (/\s/.test(code[parameterStart] ?? '')) parameterStart++
  return code[parameterStart] === '(' ? parameterStart : -1
}

function rubyMethodParameterClose(code: string): number | null {
  const parameterStart = rubyMethodParameterStart(code)
  if (parameterStart < 0) return null
  let depth = 0
  for (let i = parameterStart; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')' && --depth === 0) return i
  }
  return null
}

function rubyBlockDoMatches(code: string, continuedPrefix = ''): RegExpMatchArray[] {
  const logicalCode = `${continuedPrefix}${code}`
  return [...code.matchAll(/\bdo\b/g)].filter((match) => {
    const matchIndex = continuedPrefix.length + match.index!
    const previousSeparator = Math.max(logicalCode.lastIndexOf(';', matchIndex), logicalCode.lastIndexOf('\n', matchIndex))
    const statementPrefix = logicalCode.slice(previousSeparator + 1, matchIndex)
    return !/\b(?:while|until|for)\b/.test(statementPrefix) || /\bdo\b/.test(statementPrefix)
  })
}

function rubyBlockParameters(code: string): Array<{
  index: number
  names: Set<string>
  brace: boolean
  parameterRange?: [number, number]
  pendingParameters?: string
}> {
  const blocks: Array<{
    index: number
    names: Set<string>
    brace: boolean
    parameterRange?: [number, number]
    pendingParameters?: string
  }> = []
  const lambdaBraces = new Set<number>()
  for (const match of code.matchAll(/->\s*\(/g)) {
    const parameterStart = match.index! + match[0]!.lastIndexOf('(')
    let depth = 0
    let parameterClose = -1
    for (let i = parameterStart; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')' && --depth === 0) {
        parameterClose = i
        break
      }
    }
    if (parameterClose < 0) continue
    let index = parameterClose + 1
    while (/\s/.test(code[index] ?? '')) index++
    if (code[index] !== '{') continue
    blocks.push({
      index,
      names: rubyParameterNames(code.slice(parameterStart + 1, parameterClose)),
      brace: true,
      parameterRange: [parameterStart + 1, parameterClose],
    })
    lambdaBraces.add(index)
  }
  for (const match of code.matchAll(/->\s*\{/g)) {
    const index = match.index! + match[0]!.lastIndexOf('{')
    blocks.push({ index, names: new Set(), brace: true })
    lambdaBraces.add(index)
  }
  for (const match of code.matchAll(/(?:\bdo|\{)\s*\|/g)) {
    const parameterStart = match.index! + match[0]!.length
    const parameterClose = rubyBlockParameterClose(code, parameterStart)
    const pendingParameters = parameterClose === null ? code.slice(parameterStart) : undefined
    const names = parameterClose === null
      ? new Set<string>()
      : rubyParameterNames(code.slice(parameterStart, parameterClose))
    blocks.push({
      index: match.index!,
      names,
      brace: match[0]!.startsWith('{'),
      ...(pendingParameters === undefined ? {} : { pendingParameters }),
    })
  }
  for (const match of rubyBlockDoMatches(code)) {
    if (!/^\s*\|/.test(code.slice(match.index! + match[0]!.length))) {
      blocks.push({ index: match.index!, names: new Set(), brace: false })
    }
  }
  for (const match of code.matchAll(/\{/g)) {
    if (lambdaBraces.has(match.index!)) continue
    if (/^\s*\|/.test(code.slice(match.index! + 1))) continue
    const before = code.slice(0, match.index).trimEnd()
    const previousToken = before.match(/([A-Za-z_]\w*[!?]?|[)\]])$/)?.[1]
    if (
      previousToken === undefined
      || /^(?:begin|case|class|def|do|else|elsif|ensure|for|if|module|rescue|return|then|unless|until|when|while|yield)$/.test(previousToken)
    ) continue
    blocks.push({ index: match.index!, names: new Set(), brace: true })
  }
  return blocks.sort((left, right) => left.index - right.index)
}

function rubyBlockOpenerCount(code: string, continuedPrefix = ''): number {
  const blockDo = rubyBlockDoMatches(code, continuedPrefix).length
  return (code.match(/(?:^|;|\bthen\b)\s*(?:class|module|def|if|unless|case|begin|while|until|for)\b/g)?.length ?? 0) +
    (code.match(/(?<![=!<>])=(?!=)\s*(?:if|unless|case|while|until|for)\b/g)?.length ?? 0) +
    (code.match(/(?<![=!<>])=\s*begin\b/g)?.length ?? 0) +
    blockDo
}

function rubyIsInsideBlockScope(code: string, sourcePosition: number): boolean {
  const prefix = code.slice(0, sourcePosition)
  const events: Array<{ index: number; block: boolean; closes: boolean }> = []
  const scopeOpeners = /(?:^|;|\bthen\b)\s*(class|module|def|if|unless|case|begin|while|until|for)\b|(?<![=!<>])=(?!=)\s*(if|unless|case|while|until|for)\b|(?<![=!<>])=\s*(begin)\b/g
  for (const match of prefix.matchAll(scopeOpeners)) {
    const opener = match[1] ?? match[2] ?? match[3]!
    events.push({ index: match.index! + match[0].lastIndexOf(opener), block: false, closes: false })
  }
  for (const match of rubyBlockDoMatches(prefix)) {
    events.push({ index: match.index!, block: true, closes: false })
  }
  for (const match of prefix.matchAll(/(?<![:\w@$])end\b(?!:)/g)) {
    events.push({ index: match.index!, block: false, closes: true })
  }
  events.sort((left, right) => left.index - right.index)
  const scopes: boolean[] = []
  for (const event of events) {
    if (event.closes) scopes.pop()
    else scopes.push(event.block)
  }
  if (scopes.includes(true)) return true
  for (const block of rubyBlockParameters(prefix)) {
    if (!block.brace) continue
    let depth = 0
    for (const ch of prefix.slice(block.index)) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth > 0) return true
  }
  return false
}

function rubyLocalScopeAtPosition(
  scopes: readonly RubyLocalScope[],
  blockDepth: number,
  braceDepth: number,
  sourcePosition?: number,
): RubyLocalScope {
  let activeScope = scopes[0]!
  for (const scope of scopes) {
    if (sourcePosition !== undefined && scope.sourceIndex !== undefined && scope.sourceIndex > sourcePosition) continue
    const scopeActive = scope.baseBraceDepth === undefined
      ? blockDepth > scope.baseDepth
      : braceDepth >= scope.baseBraceDepth
    if (scopeActive) activeScope = scope
  }
  return activeScope
}

function rubyBlockDelta(
  line: string,
  state: LexicalState,
  lang: LanguageDef,
): { delta: number; code: string; heredocs: RubyHeredocState[]; endlessMethodContinuation?: boolean } {
  if (state.rubyEmbeddedDoc) {
    rubyEmbeddedDocumentationLine(line, state)
    return { delta: 0, code: ' '.repeat(line.length), heredocs: [] }
  }
  if (state.rubyHeredocs.length > 0) {
    const heredoc = state.rubyHeredocs[0]!
    const isTerminator = heredoc.allowIndent ? line.trim() === heredoc.delimiter : line === heredoc.delimiter
    rubyHeredocLine(line, state)
    if (!isTerminator && heredoc.interpolating) {
      const activeScope = state.rubyLocalScopes.at(-1)!
      for (const name of rubyHeredocInterpolationAssignments(line)) activeScope.names.add(name)
    }
    return { delta: 0, code: ' '.repeat(line.length), heredocs: [] }
  }
  if (rubyHeredocLine(line, state)) return { delta: 0, code: ' '.repeat(line.length), heredocs: [] }
  const interpolationExpressions: Array<{ code: string; index: number }> = []
  const code = rubyCodeWithoutLiterals(line, state, interpolationExpressions)
  if (rubyEmbeddedDocumentationLine(code, state)) return { delta: 0, code: ' '.repeat(line.length), heredocs: [] }
  for (const scope of state.rubyLocalScopes) delete scope.sourceIndex
  const continuedPrefix = state.rubyContinuationPrefix
  state.rubyContinuationPrefix = ''
  const endlessMethodBody = state.rubyEndlessMethodBodyPending && code.trim().length > 0
  const endlessMethodBodyParameters = new Set(state.rubyEndlessMethodBodyParameters)
  if (endlessMethodBody) state.rubyEndlessMethodBodyPending = false
  if (endlessMethodBody) state.rubyEndlessMethodBodyParameters = new Set()
  const enclosingScope = state.rubyLocalScopes.at(-1)!
  let completedPendingEndlessMethod: string | null = null
  if (enclosingScope.pendingMethodParameters !== undefined) {
    const pendingParameters = `${enclosingScope.pendingMethodParameters}\n${code}`
    if (rubyMethodParametersComplete(pendingParameters)) {
      if (isRubyEndlessMethod(pendingParameters)) {
        completedPendingEndlessMethod = pendingParameters
      } else {
        for (const name of rubyMethodParameterNames(pendingParameters)) enclosingScope.names.add(name)
      }
      delete enclosingScope.pendingMethodParameters
    } else {
      enclosingScope.pendingMethodParameters = pendingParameters
    }
  }
  for (const scope of state.rubyLocalScopes) {
    if (scope.pendingBlockParameters === undefined) continue
    const pendingParameters = `${scope.pendingBlockParameters}\n${code}`
    const closingBar = rubyBlockParameterClose(pendingParameters, 0)
    if (closingBar !== null) {
      for (const name of rubyParameterNames(pendingParameters.slice(0, closingBar))) scope.names.add(name)
      delete scope.pendingBlockParameters
    } else {
      scope.pendingBlockParameters = pendingParameters
    }
  }
  const scopeDeclarations = [...code.matchAll(/(?:^|;)\s*(class|module|def)\b/g)]
  const scopeDeclaration = scopeDeclarations.at(-1) ?? null
  const declarationStart = scopeDeclaration?.index ?? -1
  const declarationCode = scopeDeclaration === null
    ? ''
    : code.slice(declarationStart).replace(/^(?:;)?\s*/, '')
  const endlessMethodDeclaration = completedPendingEndlessMethod ?? declarationCode
  const endlessMethod = completedPendingEndlessMethod !== null
    || (scopeDeclaration?.[1] === 'def' && isRubyEndlessMethod(declarationCode))
  const endlessMethodHeader = endlessMethod && /=$/.test(endlessMethodDeclaration.trimEnd())
  const endlessMethodContinuesOnNextLine = endlessMethod
    && rubyExpressionContinues(endlessMethodDeclaration, lang, rubyEndlessMethodParameters(endlessMethodDeclaration))
  const endlessMethodCount = code
    .split(';')
    .filter((statement) => isRubyEndlessMethod(statement.trim()))
    .length
  const localScopeDeclarations = scopeDeclarations.flatMap((declaration, index) => {
    const kind = declaration[1]!
    const start = declaration.index! + declaration[0].lastIndexOf(kind)
    const end = scopeDeclarations[index + 1]?.index ?? code.length
    const text = code.slice(start, end).trim()
    return kind === 'def' && isRubyEndlessMethod(text) ? [] : [{ kind, start, text }]
  })
  if (endlessMethodHeader || endlessMethodContinuesOnNextLine) {
    state.rubyEndlessMethodBodyPending = true
    state.rubyEndlessMethodBodyParameters = new Set(rubyEndlessMethodParameters(endlessMethodDeclaration))
    for (const name of rubyAssignedLocalNames(endlessMethodDeclaration)) {
      state.rubyEndlessMethodBodyParameters.add(name)
    }
  }
  for (const declaration of localScopeDeclarations) {
    const prefix = code.slice(0, declaration.start)
    const closesBefore = prefix.match(/(?<![:\w@$])end\b(?!:)/g)?.length ?? 0
    const baseDepth = state.rubyBlockDepth + rubyBlockOpenerCount(prefix, continuedPrefix) - closesBefore
    const names = declaration.kind === 'def'
      ? rubyMethodParameterNames(declaration.text)
      : new Set<string>()
    const scope: RubyLocalScope = { baseDepth, names }
    if (declaration.kind === 'def' && rubyMethodParametersIncomplete(declaration.text)) {
      scope.pendingMethodParameters = declaration.text
    }
    state.rubyLocalScopes.push(scope)
  }
  const blockParameters = rubyBlockParameters(code)
  for (const block of blockParameters) {
    const prefix = code.slice(0, block.index)
    const prefixCloses = prefix.match(/(?<![:\w@$])end\b(?!:)/g)?.length ?? 0
    const parentScope = rubyLocalScopeAtPosition(
      state.rubyLocalScopes,
      state.rubyBlockDepth + rubyBlockOpenerCount(prefix, continuedPrefix) - prefixCloses,
      state.rubyBraceDepth + (prefix.match(/{/g)?.length ?? 0) - (prefix.match(/}/g)?.length ?? 0),
      block.index,
    )
    const names = new Set(parentScope.names)
    for (const name of block.names) names.add(name)
    const scope: RubyLocalScope = {
      baseDepth: state.rubyBlockDepth + rubyBlockOpenerCount(prefix, continuedPrefix) - prefixCloses,
      names,
      sourceIndex: block.index,
      ...(block.pendingParameters === undefined ? {} : { pendingBlockParameters: block.pendingParameters }),
    }
    if (block.brace) {
      scope.baseBraceDepth = state.rubyBraceDepth
        + (prefix.match(/{/g)?.length ?? 0)
        - (prefix.match(/}/g)?.length ?? 0)
        + 1
    }
    state.rubyLocalScopes.push(scope)
  }
  const opens = rubyBlockOpenerCount(code, continuedPrefix)
  const closes = code.match(/(?<![:\w@$])end\b(?!:)/g)?.length ?? 0
  const localScope = state.rubyLocalScopes.at(-1)!
  const knownLocals = new Set(localScope.names)
  for (const match of code.matchAll(/\bfor\s+(.+?)\s+in\b/g)) {
    const prefix = code.slice(0, match.index!)
    const closesBefore = prefix.match(/(?<![:\w@$])end\b(?!:)/g)?.length ?? 0
    const variableScope = rubyLocalScopeAtPosition(
      state.rubyLocalScopes,
      state.rubyBlockDepth + rubyBlockOpenerCount(prefix, continuedPrefix) - closesBefore,
      state.rubyBraceDepth + (prefix.match(/{/g)?.length ?? 0) - (prefix.match(/}/g)?.length ?? 0),
      match.index!,
    )
    for (const name of rubyParameterNames(match[1]!)) {
      knownLocals.add(name)
      variableScope.names.add(name)
    }
  }
  const interpolationAssignments: Array<{ name: string; index: number; blockScoped: boolean }> = []
  for (const expression of interpolationExpressions) {
    for (const match of rubyAssignedLocalMatches(expression.code)) {
      interpolationAssignments.push({
        name: match[1]!,
        index: expression.index,
        blockScoped: rubyIsInsideBlockScope(expression.code, match.index!),
      })
    }
  }
  const interpolationAssignedLocalNames = new Set(
    interpolationAssignments.filter((assignment) => !assignment.blockScoped).map((assignment) => assignment.name),
  )
  const lambdaParameterRanges = blockParameters.flatMap((block) => block.parameterRange === undefined ? [] : [block.parameterRange])
  const assignmentMatches = rubyAssignedLocalMatches(code).filter((match) =>
    !lambdaParameterRanges.some(([start, end]) => match.index! >= start && match.index! < end),
  )
  const assignedLocalNames = new Set(interpolationAssignedLocalNames)
  for (const match of assignmentMatches) assignedLocalNames.add(match[1]!)
  if (endlessMethod || endlessMethodBody) {
    for (const name of rubyEndlessMethodParameters(endlessMethodDeclaration)) knownLocals.add(name)
    for (const name of endlessMethodBodyParameters) knownLocals.add(name)
    for (const local of assignedLocalNames) knownLocals.add(local)
  }
  const scopedLocals = new Set(state.rubyLocalScopes.flatMap((scope) => [...scope.names]))
  const knownLocalsAtPosition = (index: number): ReadonlySet<string> => {
    const prefix = code.slice(0, index)
    const closesBefore = prefix.match(/(?<![:\w@$])end\b(?!:)/g)?.length ?? 0
    const activeScope = rubyLocalScopeAtPosition(
      state.rubyLocalScopes,
      state.rubyBlockDepth + rubyBlockOpenerCount(prefix, continuedPrefix) - closesBefore,
      state.rubyBraceDepth + (prefix.match(/{/g)?.length ?? 0) - (prefix.match(/}/g)?.length ?? 0),
      index,
    )
    const activeNames = new Set(knownLocals)
    for (const name of scopedLocals) {
      if (!activeScope.names.has(name)) activeNames.delete(name)
    }
    for (const name of activeScope.names) activeNames.add(name)
    return activeNames
  }
  const heredocs = rubyHeredocOpeners(code, knownLocals, knownLocalsAtPosition)
  if (!endlessMethod && !endlessMethodBody) {
    for (const assignment of interpolationAssignments) {
      if (assignment.blockScoped) continue
      const prefix = code.slice(0, assignment.index)
      const closesBefore = prefix.match(/(?<![:\w@$])end\b(?!:)/g)?.length ?? 0
      const assignmentBlockDepth = state.rubyBlockDepth + rubyBlockOpenerCount(prefix, continuedPrefix) - closesBefore
      const assignmentBraceDepth = state.rubyBraceDepth
        + (prefix.match(/{/g)?.length ?? 0)
        - (prefix.match(/}/g)?.length ?? 0)
      rubyLocalScopeAtPosition(state.rubyLocalScopes, assignmentBlockDepth, assignmentBraceDepth, assignment.index)
        .names.add(assignment.name)
    }
    for (const match of assignmentMatches) {
      const prefix = code.slice(0, match.index!)
      const closesBefore = prefix.match(/(?<![:\w@$])end\b(?!:)/g)?.length ?? 0
      const assignmentBlockDepth = state.rubyBlockDepth + rubyBlockOpenerCount(prefix, continuedPrefix) - closesBefore
      const assignmentBraceDepth = state.rubyBraceDepth
        + (prefix.match(/{/g)?.length ?? 0)
        - (prefix.match(/}/g)?.length ?? 0)
      const assignmentScope = rubyLocalScopeAtPosition(state.rubyLocalScopes, assignmentBlockDepth, assignmentBraceDepth, match.index!)
      assignmentScope.names.add(match[1]!)
    }
  }
  const delta = opens - closes - endlessMethodCount - (completedPendingEndlessMethod === null ? 0 : 1)
  state.rubyBlockDepth = Math.max(0, state.rubyBlockDepth + delta)
  state.rubyBraceDepth = Math.max(
    0,
    state.rubyBraceDepth + (code.match(/{/g)?.length ?? 0) - (code.match(/}/g)?.length ?? 0),
  )
  const trimmedCode = code.trimEnd()
  if (trimmedCode.endsWith('\\')) {
    state.rubyContinuationPrefix = `${continuedPrefix}${trimmedCode.slice(0, -1)}`
  }
  while (state.rubyLocalScopes.length > 1) {
    const currentScope = state.rubyLocalScopes.at(-1)!
    const scopeEnded = currentScope.baseBraceDepth === undefined
      ? state.rubyBlockDepth <= currentScope.baseDepth
      : state.rubyBraceDepth < currentScope.baseBraceDepth
    if (!scopeEnded) break
    state.rubyLocalScopes.pop()
  }
  if (endlessMethodBody && rubyExpressionContinues(line, lang, endlessMethodBodyParameters)) {
    state.rubyEndlessMethodBodyPending = true
    state.rubyEndlessMethodBodyParameters = new Set(endlessMethodBodyParameters)
    for (const name of assignedLocalNames) state.rubyEndlessMethodBodyParameters.add(name)
  }
  return {
    delta,
    code,
    heredocs,
    endlessMethodContinuation: completedPendingEndlessMethod !== null && endlessMethodContinuesOnNextLine,
  }
}

/** Pick the best one-line summary for a chunk. */
export function pickSummary(
  lines: readonly string[],
  symbol: string,
  lang: LanguageDef | null,
): string {
  if (symbol.length > 0) return symbol
  for (const line of lines) {
    const t = line.trim()
    if (t.length === 0 || isCommentLine(line, lang)) continue
    return collapseWhitespace(t)
  }
  return ''
}

/**
 * Chunk one file's raw text into fragments.
 * @param text  raw file content (may contain CRLF; normalized internally)
 * @param lang  language definition, or null for plain text (no symbols)
 */
export function chunkText(text: string, lang: LanguageDef | null, opts: ChunkOptions): ChunkCandidate[] {
  const content = text.replace(/\r\n?/g, '\n')
  if (content.length === 0) return []
  const lines = content.split('\n')
  const structuralLines = lang?.name === 'cpp'
    ? maskCppStructuralTokens(content).split('\n')
    : lines
  const braceLines = lang?.name === 'cpp' ? maskCppDirectives(structuralLines, lines) : structuralLines
  const linkageLines = lang?.name === 'cpp'
    ? content
      .replace(/R"([^ ()\\\t\v\f\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\(?:\n|[^\n])|[^"\\\n])*"|'(?:\\(?:\n|[^\n])|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/(?:(?:[^\n]*?)\\\n)*[^\n]*/g, (token) =>
        token.startsWith('R"') || token.startsWith('"') || token.startsWith("'") ? token : token.replace(/[^\n]/g, ' '),
      )
      .split('\n')
    : lines
  const n = lines.length
  if (n === 0) return []

  const maxLines = Math.max(1, Math.floor(opts.maxLines))

  // Pass 1: boundary detection with symbol propagation.
  const boundary = new Array<boolean>(n).fill(false)
  const symAt = new Array<string>(n).fill('')
  const kotlinAnnotationBoundary = new Array<boolean>(n).fill(false)
  const braceBalanceAtLine = new Array<number>(n).fill(0)
  const rubyEmbeddedDocLines = new Array<boolean>(n).fill(false)
  const boundaryLexicalState = newLexicalState()
  let cLinkageDepth = 0
  let pendingCLinkage = false
  let pendingExternKeywordLine: number | null = null
  let pendingClass = false
  let pendingClassName: string | null = null
  let pendingNamespace = false
  const cppScopes: Array<'block' | 'class' | 'linkage' | 'namespace'> = []
  const cppScopeClassNames: Array<string | null> = []
  let inDirectiveContinuation = false
  let pendingCppTemplate: { startLine: number; text: string } | null = null
  let pendingCppClassMemberType: { startLine: number; text: string } | null = null
  let pendingCLinkageDeclaration: { startLine: number; text: string; inCLinkageBlock: boolean } | null = null
  const pendingKotlinAnnotations: number[] = []
  for (let i = 0; i < n; i++) {
    if (!lang) continue
    const line = lines[i]!
    const phpCodeAtLineStart = lang.name !== 'php' || boundaryLexicalState.phpInCode
    const structuralLine = phpCodeAtLineStart ? structuralLines[i]! : ''
    const inRubyHeredoc = lang.name === 'ruby' && boundaryLexicalState.rubyHeredocs.length > 0
    const inRubyEmbeddedDoc = lang.name === 'ruby' && boundaryLexicalState.rubyEmbeddedDoc
    const physicalLinkageLine = linkageLines[i]!
    const linkageLine = i < n - 1 && structuralLine.endsWith('\\')
      ? physicalLinkageLine.slice(0, -1)
      : physicalLinkageLine
    const directive = structuralLine.trimStart()
    const isDirective = lang.name === 'cpp'
      && (inDirectiveContinuation || directive.startsWith('#') || directive.startsWith('%:'))
    if (isDirective) {
      inDirectiveContinuation = /\\$/.test(line)
      continue
    }
    const cLinkageBraces: number[] = lang.name === 'cpp'
      ? cLinkageOpenBraces(structuralLine, linkageLine, pendingExternKeywordLine !== null)
      : []
    const cLinkageBrace = cLinkageBraces[0] ?? -1
    const opensCLinkage = cLinkageBraces.length > 0
    const opensPendingCLinkage = lang.name === 'cpp' && pendingCLinkage && /^\s*\{/.test(structuralLine)
    const opensPendingClass = lang.name === 'cpp' && pendingClass && structuralLine.includes('{')
    const opensPendingNamespace = lang.name === 'cpp' && pendingNamespace && structuralLine.includes('{')
    const allowExtern = lang.name !== 'cpp' || !cppScopes.includes('block')
    const inCLinkageBlock = lang.name === 'cpp'
      && (pendingCLinkage || (cppScopes.includes('linkage') && !cppScopes.includes('block')))
      && !cppScopes.includes('class')
    const splitExternC: boolean = lang.name === 'cpp'
      && pendingExternKeywordLine !== null
      && /^\s*"C"(?:\s|$)/.test(linkageLine)
    const splitExternCHeader = splitExternC && /^\s*"C"\s*$/.test(linkageLine)
    const isPendingCLinkageHeader = lang.name === 'cpp' && /^\s*extern(?:\s+|(?="C"))"C"\s*$/.test(linkageLine)
    if (isPendingCLinkageHeader) pendingCLinkageDeclaration = null
    const canBufferCDeclaration = lang.name === 'cpp'
      && !isPendingCLinkageHeader
      && (inCLinkageBlock || splitExternC || /^extern(?:\s+|(?="C"))/.test(linkageLine.trimStart()))
    const semicolon = structuralLine.indexOf(';')
    const declarationLine = splitExternC ? `extern ${linkageLine.trim()}` : linkageLine
    const declarationFragment = semicolon < 0 ? linkageLine.trim() : linkageLine.slice(0, semicolon + 1).trim()
    const declarationText: string = splitExternC ? `extern ${declarationFragment}` : declarationFragment
    const declarationHasScopeBrace = structuralLine.includes('{') || structuralLine.includes('}')
    let declarationStart: number = splitExternC ? pendingExternKeywordLine! : i
    const inCppClassScope = lang.name === 'cpp' && cppScopes.at(-1) === 'class'
    const inCppNamespaceOrFileScope = lang.name === 'cpp' && cppScopes.every((scope) => scope === 'namespace')
    const cppClassName = inCppClassScope ? cppScopeClassNames.at(-1) ?? null : null
    const symbolLine = skipLeadingBlockComments(line, lang, boundaryLexicalState.blockCommentDepth)
    const matchLine = lang.name === 'php' ? stripInlineComments(symbolLine, lang).trimStart() : symbolLine
    let symbol = lang.name === 'cpp'
      ? matchSymbol(declarationLine, lang, inCLinkageBlock, allowExtern, inCppClassScope, inCppNamespaceOrFileScope, cppClassName)
      : symbolLine.trim().length > 0
        && phpCodeAtLineStart
        && boundaryLexicalState.phpHeredoc === null
        && boundaryLexicalState.bashHeredocs.length === 0
        && boundaryLexicalState.bashContinuationPrefix === null
        && boundaryLexicalState.quote === null
        && boundaryLexicalState.csharpRawStringQuoteLength === null
        && !boundaryLexicalState.regex
        && boundaryLexicalState.templates.every(({ inExpression }) => inExpression)
        && boundaryLexicalState.rubyQuote === null
        && boundaryLexicalState.rubyDelimited === null
        && !boundaryLexicalState.rubyRegex
        && boundaryLexicalState.rustRawStringHashes === null
        && boundaryLexicalState.swiftRawStringHashes === null
        && boundaryLexicalState.swiftRawRegexHashes === null
        && !inRubyEmbeddedDoc
        && !inRubyHeredoc
        ? matchSymbol(matchLine, lang)
        : ''
    const isCppTemplateHeader = lang.name === 'cpp' && /^template\s*<[^;{}]+>\s*$/.test(structuralLine.trim())
    if (lang.name === 'cpp' && pendingCppTemplate && !isCppTemplateHeader) {
      const templateSymbol = matchSymbol(
        `${pendingCppTemplate.text} ${declarationLine}`.trim(),
        lang,
        inCLinkageBlock,
        allowExtern,
        inCppClassScope,
        inCppNamespaceOrFileScope,
        cppClassName,
      )
      if (templateSymbol.length > 0) {
        symbol = templateSymbol
        declarationStart = pendingCppTemplate.startLine
        pendingCppTemplate = null
      } else if (declarationLine.trim().length > 0 && (symbol.length > 0 || semicolon >= 0 || declarationHasScopeBrace)) {
        pendingCppTemplate = null
      }
    }
    if (lang.name === 'cpp' && pendingCppClassMemberType) {
      const combinedMethod = matchSymbol(
        `${pendingCppClassMemberType.text} ${declarationLine}`.trim(),
        lang,
        inCLinkageBlock,
        allowExtern,
        inCppClassScope,
        inCppNamespaceOrFileScope,
        cppClassName,
      )
      if (combinedMethod.length > 0) {
        symbol = combinedMethod
        declarationStart = pendingCppClassMemberType.startLine
        pendingCppClassMemberType = null
      } else if (declarationLine.trim().length > 0 || declarationHasScopeBrace) {
        pendingCppClassMemberType = null
      }
    }
    if (isCppTemplateHeader) {
      pendingCppTemplate = pendingCppTemplate
        ? { startLine: pendingCppTemplate.startLine, text: `${pendingCppTemplate.text} ${linkageLine.trim()}` }
        : { startLine: i, text: linkageLine.trim() }
    }
    if (
      splitExternC
      && pendingCLinkageDeclaration?.text.trim() === 'extern'
      && pendingCLinkageDeclaration.startLine === pendingExternKeywordLine
    ) {
      pendingCLinkageDeclaration = null
    }
    if (lang.name === 'cpp' && pendingCLinkageDeclaration) {
      const combinedSymbol = matchSymbol(
        `${pendingCLinkageDeclaration.text} ${declarationText}`.trim(),
        lang,
        pendingCLinkageDeclaration.inCLinkageBlock || inCLinkageBlock,
        allowExtern,
      )
      if (combinedSymbol.length > 0) {
        symbol = combinedSymbol
        declarationStart = pendingCLinkageDeclaration.startLine
        pendingCLinkageDeclaration = null
      } else if (symbol.length > 0 || semicolon >= 0 || declarationHasScopeBrace) {
        pendingCLinkageDeclaration = null
      } else if (declarationText.length > 0) {
        pendingCLinkageDeclaration.text += ` ${declarationText}`
      }
    } else if (
      canBufferCDeclaration
      && symbol.length === 0
      && declarationText.length > 0
      && semicolon < 0
      && !declarationHasScopeBrace
    ) {
      pendingCLinkageDeclaration = { startLine: declarationStart, text: declarationText, inCLinkageBlock }
    }
    if (lang.name === 'cpp' && inCppClassScope) {
      if (symbol.length > 0 || semicolon >= 0 || declarationHasScopeBrace) {
        pendingCppClassMemberType = null
      } else if (pendingCppClassMemberType === null && pendingCppTemplate === null && CPP_CLASS_MEMBER_TYPE_RE.test(structuralLine.trim())) {
        pendingCppClassMemberType = { startLine: i, text: structuralLine.trim() }
      }
    }
    if (opensCLinkage || opensPendingCLinkage) {
      const openBrace = opensCLinkage ? cLinkageBraces[cLinkageBraces.length - 1]! : linkageLine.indexOf('{')
      const inlineDeclaration = linkageLine.slice(openBrace + 1).replace(/(?:\}\s*)+$/, '').trim()
      const inlineSymbol = matchSymbol(inlineDeclaration, lang, true)
      if (inlineSymbol.length > 0) {
        symbol = inlineSymbol
      } else {
        const inlineStructural = structuralLine.slice(openBrace + 1).replace(/(?:\}\s*)+$/, '').trim()
        if (inlineDeclaration.length > 0 && inlineStructural.indexOf(';') < 0 && !/[{}]/.test(inlineStructural)) {
          pendingCLinkageDeclaration = { startLine: i, text: inlineDeclaration, inCLinkageBlock: true }
        }
      }
    }
    if (lang.name === 'kotlin') {
      const annotationCode = stripInlineComments(symbolLine, lang).trim()
      if (
        boundaryLexicalState.quote === null
        && isKotlinAnnotationLine(annotationCode)
        && !/^@file\s*:/.test(annotationCode)
      ) {
        pendingKotlinAnnotations.push(i)
      } else if (annotationCode.length > 0 && boundaryLexicalState.parenDepth === 0) {
        if (symbol.length > 0) {
          for (const annotationLine of pendingKotlinAnnotations) {
            boundary[annotationLine] = true
            symAt[annotationLine] = symbol
            kotlinAnnotationBoundary[annotationLine] = true
          }
        }
        pendingKotlinAnnotations.length = 0
      }
    }
    if (symbol.length > 0) {
      boundary[declarationStart] = true
      symAt[declarationStart] = symbol
    }
    if (lang.name === 'cpp') {
      const endsPendingCLinkage = pendingCLinkage && structuralLine.trim().length > 0
      if (opensCLinkage || opensPendingCLinkage || cLinkageDepth > 0) {
        const linkageLineForDepth = opensCLinkage && cLinkageDepth === 0
          ? structuralLine.slice(cLinkageBrace)
          : structuralLine
        const braceDelta = (linkageLineForDepth.match(/\{/g)?.length ?? 0) - (linkageLineForDepth.match(/\}/g)?.length ?? 0)
        cLinkageDepth = Math.max(0, cLinkageDepth + braceDelta)
        pendingCLinkage = false
      } else if (endsPendingCLinkage) {
        pendingCLinkage = false
      }
      if (/^\s*extern(?:\s+|(?="C"))"C"\s*$/.test(linkageLine)) pendingCLinkage = true
      if (pendingExternKeywordLine !== null && linkageLine.trim().length > 0) {
        if (splitExternCHeader) pendingCLinkage = true
        pendingExternKeywordLine = null
      } else if (/^\s*extern\s*$/.test(linkageLine)) {
        pendingExternKeywordLine = i
      }

      let firstBrace = true
      let braceSegmentStart = 0
      for (let braceIndex = 0; braceIndex < structuralLine.length; braceIndex++) {
        const char = structuralLine[braceIndex]!
        if (char === '{') {
          const segment = structuralLine.slice(braceSegmentStart, braceIndex)
          const opensNamespaceHere = SPLIT_NAMESPACE_HEADER_RE.test(segment)
          const opensCLinkageHere = cLinkageBraces.includes(braceIndex) || (firstBrace && opensPendingCLinkage)
          const classNameMatch = segment.match(/^\s*(?:template\s*<[^;{}]+>\s*)?(?:class|struct|union)\s+([A-Za-z_]\w*)\b/)
          const opensClassHere = classNameMatch !== null || (firstBrace && opensPendingClass)
          const scope = opensCLinkageHere
            ? 'linkage'
            : opensNamespaceHere || (firstBrace && opensPendingNamespace)
              ? 'namespace'
              : opensClassHere
                ? 'class'
                : 'block'
          cppScopes.push(scope)
          cppScopeClassNames.push(scope === 'class'
            ? classNameMatch?.[1] ?? (firstBrace && opensPendingClass ? pendingClassName : null)
            : null)
          firstBrace = false
          braceSegmentStart = braceIndex + 1
        } else if (char === '}') {
          cppScopes.pop()
          cppScopeClassNames.pop()
          braceSegmentStart = braceIndex + 1
        }
      }
      if (pendingClass && (structuralLine.includes('{') || structuralLine.includes(';'))) {
        pendingClass = false
        pendingClassName = null
      }
      const pendingClassHeader = structuralLine.match(/^\s*(?:template\s*<[^;{}]+>\s*)?(?:class|struct|union)\s+([A-Za-z_]\w*)\b[^{};]*$/)
      if (pendingClassHeader) {
        pendingClass = true
        pendingClassName = pendingClassHeader[1]!
      }
      const isNamespaceName = /^\s*[\w:]+\s*$/.test(structuralLine)
      if (pendingNamespace && structuralLine.trim().length > 0 && !isNamespaceName) pendingNamespace = false
      if (SPLIT_NAMESPACE_HEADER_RE.test(structuralLine)) pendingNamespace = true

    }
    const rubyLine = lang.name === 'ruby' ? rubyBlockDelta(line, boundaryLexicalState, lang) : null
    rubyEmbeddedDocLines[i] = lang.name === 'ruby'
      && (inRubyEmbeddedDoc || boundaryLexicalState.rubyEmbeddedDoc)
    const scan = braceDelta(
      lang.name === 'cpp' ? structuralLine : rubyLine?.code ?? line,
      boundaryLexicalState,
      lang,
    )
    braceBalanceAtLine[i] = scan.balance
    if (rubyLine) boundaryLexicalState.rubyHeredocs.push(...rubyLine.heredocs)
  }

  // Weighted cut helper: emit lines [start, end).
  const chunks: ChunkCandidate[] = []
  const flush = (start: number, end: number, symbol: string): void => {
    if (end <= start || start >= n) return
    const slice = lines.slice(start, end)
    chunks.push({
      startLine: start + 1,
      endLine: end,
      content: slice.join('\n'),
      symbol,
      summary: pickSummary(slice, symbol, lang),
    })
  }

  let start = 0
  let braceDepth = 0
  const lexicalState = newLexicalState()
  const blockCommentDepthAtLineStart = new Array<number>(n).fill(0)
  const scopes: SymbolScope[] = []
  const nextCodeLineCache = new Map<number, { code: string; indent: number } | null>()
  let previousNonCommentLine = -1
  const currentSymbol = (): string => scopes.at(-1)?.symbol ?? ''
  for (let i = 0; i < n; i++) {
    const line = lines[i]!
    blockCommentDepthAtLineStart[i] = lexicalState.blockCommentDepth
    const quoteAtLineStart = lexicalState.quote
    const escapedAtLineStart = lexicalState.escaped
    const nonBlank = line.trim().length > 0
    const phpCodeAtLineStart = lang?.name !== 'php' || lexicalState.phpInCode
    const rubyEmbeddedDocLine = rubyEmbeddedDocLines[i]!
    const languageCommentLine = nonBlank
      && isCommentLine(line, lang, lexicalState.blockCommentDepth)
    const commentLine = nonBlank && phpCodeAtLineStart
      && (rubyEmbeddedDocLine || languageCommentLine)
    const previousCodeLineBeforeCurrent = previousNonCommentLine
    const structuralLine = nonBlank && phpCodeAtLineStart && !commentLine
    const lexicalContinuation = (lexicalState.blockCommentDepth > 0
      && skipLeadingBlockComments(line, lang, lexicalState.blockCommentDepth).trim().length === 0)
      || lexicalState.quote !== null
      || lexicalState.regex
      || lexicalState.templates.length > 0
      || lexicalState.swiftRawStringHashes !== null
      || lexicalState.swiftRawRegexHashes !== null
      || (lang?.name === 'bash' && lexicalState.bashContinuationPrefix !== null)
      || (lang?.name === 'ruby' && (
        lexicalState.rubyQuote !== null
        || lexicalState.rubyDelimited !== null
        || lexicalState.rubyRegex
        || lexicalState.rubyHeredocs.length > 0
      ))
    const indent = leadingIndent(line, lang?.name === 'python' ? 8 : 4)
    const commentOnlyLine = commentLine
      && !rubyEmbeddedDocLine
      && lexicalState.quote === null
      && lexicalState.csharpRawStringQuoteLength === null
      && !lexicalState.regex
      && lexicalState.templates.length === 0
      && lexicalState.bashHeredocs.length === 0
      && lexicalState.phpHeredoc === null
      && lexicalState.rubyQuote === null
      && lexicalState.rubyDelimited === null
      && !lexicalState.rubyRegex
      && lexicalState.rubyHeredocs.length === 0
      && lexicalState.rustRawStringHashes === null
      && lexicalState.swiftRawStringHashes === null
      && lexicalState.swiftRawRegexHashes === null

    if (rubyEmbeddedDocLine && lang?.name === 'ruby') {
      const previousCodeLine = previousCodeLineBeforeCurrent
      if (previousCodeLine >= 0) {
        for (const scope of scopes) {
          if (scope.mode !== 'expression' || !scope.expressionBodyStarted) continue
          const expressionContinues =
            braceDepth > scope.baseDepth
            || lexicalState.parenDepth > scope.baseParenDepth
            || lexicalState.bracketDepth > scope.baseBracketDepth
            || scope.rubyDepth > 0
            || lexicalContinuation
            || lineEndsWithContinuationOperator(
              lines[previousCodeLine]!,
              lang,
              blockCommentDepthAtLineStart[previousCodeLine]!,
            )
          if (!expressionContinues) scope.ended = true
        }
      }
    }

    if (!structuralLine && nonBlank) {
      while (scopes.at(-1)?.ended) {
        flush(start, i, currentSymbol())
        start = i
        scopes.pop()
      }
    }

    if (commentOnlyLine) {
      if (lang) {
        const nextCodeLine = nextCodeLineAfterComments(
          lines,
          i,
          lang,
          blockCommentDepthAtLineStart[i]!,
          nextCodeLineCache,
        )
        const previousCodeLine = previousCodeLineBeforeCurrent
        if (previousCodeLine >= 0) {
          for (const scope of scopes) {
            if (lang.name === 'python' && scope.mode === 'indent') {
              const pythonContinuation = scope.pythonHeaderPending
                || lexicalContinuation
                || braceDepth > scope.baseDepth
                || lexicalState.parenDepth > scope.baseParenDepth
                || lexicalState.bracketDepth > scope.baseBracketDepth
                || stripPythonComment(lines[previousCodeLine]!).trimEnd().endsWith('\\')
              if (!pythonContinuation && (nextCodeLine === null || nextCodeLine.indent <= scope.baseIndent)) {
                scope.ended = true
              }
              continue
            }
            if (scope.mode !== 'expression' || !scope.expressionBodyStarted) continue
            const expressionContinues =
              braceDepth > scope.baseDepth
              || lexicalState.parenDepth > scope.baseParenDepth
              || lexicalState.bracketDepth > scope.baseBracketDepth
              || (lang.name === 'ruby' && scope.rubyDepth > 0)
              || ((lang.name === 'kotlin' || lang.name === 'scala')
                && stripInlineComments(lines[previousCodeLine]!, lang).trim() === 'else')
              || lineEndsWithContinuationOperator(
                lines[previousCodeLine]!,
                lang,
                blockCommentDepthAtLineStart[previousCodeLine]!,
              )
            const indentationAllowsStatement = lang.name !== 'scala'
              || nextCodeLine === null
              || nextCodeLine.indent <= scope.baseIndent
            const nextStartsStatement = nextCodeLine === null
              || (indentationAllowsStatement
                && (isTopLevelStatementStart(nextCodeLine.code, lang, 0, lines[previousCodeLine]!)
                  || (lang.name === 'ruby' && scope.expressionBodyStarted && !expressionContinues)))
            if (!expressionContinues && nextStartsStatement) scope.ended = true
          }
        }
      }
      while (scopes.at(-1)?.ended) {
        flush(start, i, currentSymbol())
        start = i
        scopes.pop()
      }
    }

    // Keep trailing blank lines with the completed scope, but stop carrying it
    // into the next non-blank statement and restore its enclosing scope.
    if (structuralLine) {
      const scalaEndMarker = lang?.name === 'scala'
        && /^end(?:\s+[\w`]+)?$/.test(stripInlineComments(line, lang).trim())
      for (const scope of scopes) {
        if (i <= scope.startLine) continue
        if (scope.mode === 'phpNamespace') {
          if (
            lang?.name === 'php'
            && lexicalState.phpHeredoc === null
            && lexicalState.quote === null
            && /^namespace(?:\s+\\?[\w\\]+)?\s*;$/.test(stripInlineComments(line, lang).trim())
          ) scope.ended = true
        } else if (scope.mode === 'indent') {
          const pythonExplicitContinuation = lang?.name === 'python'
            && i > 0
            && stripPythonComment(lines[i - 1]!).trimEnd().endsWith('\\')
          if (
            scope.pythonHeaderPending
            || lexicalContinuation
            || braceDepth > scope.baseDepth
            || lexicalState.parenDepth > scope.baseParenDepth
            || lexicalState.bracketDepth > scope.baseBracketDepth
            || pythonExplicitContinuation
          ) continue
          if (scalaEndMarker) {
            if (indent < scope.baseIndent) scope.ended = true
          } else if (indent <= scope.baseIndent) {
            scope.ended = true
          }
        } else if (scope.mode === 'expression') {
          if (braceDepth + braceBalanceAtLine[i]! < scope.baseDepth) {
            scope.ended = true
            continue
          }
          const previousCodeLine = previousCodeLineBeforeCurrent
          const expressionContinues =
            braceDepth > scope.baseDepth ||
            lexicalState.parenDepth > scope.baseParenDepth ||
            lexicalState.bracketDepth > scope.baseBracketDepth ||
            (lang?.name === 'ruby' && scope.rubyDepth > 0) ||
            lexicalContinuation ||
            (previousCodeLine >= 0
              && (lang?.name === 'kotlin' || lang?.name === 'scala')
              && stripInlineComments(lines[previousCodeLine]!, lang!).trim() === 'else') ||
            (previousCodeLine >= 0 && lineEndsWithContinuationOperator(lines[previousCodeLine]!, lang, blockCommentDepthAtLineStart[previousCodeLine]!))
          const statementIndent = lang
            && (lexicalState.blockCommentDepth > 0 || line.trimStart().startsWith('/*'))
            ? nextCodeLineAfterComments(
              [line],
              0,
              lang,
              blockCommentDepthAtLineStart[i]!,
            )?.indent ?? indent
            : indent
          const indentationDefinesScope = lang?.name === 'scala' || lang?.name === 'python'
          const indentationAllowsStatement = !indentationDefinesScope || statementIndent <= scope.baseIndent
          if (scalaEndMarker && indent < scope.baseIndent) {
            scope.ended = true
            continue
          }
          const startsStatement = indentationAllowsStatement && (
            isTopLevelStatementStart(
              line,
              lang,
              blockCommentDepthAtLineStart[i]!,
              previousCodeLine >= 0 ? lines[previousCodeLine]! : undefined,
            )
            || (lang?.name === 'ruby' && scope.expressionBodyStarted && !expressionContinues)
          )
          if (startsStatement && !expressionContinues && scope.expressionBodyStarted) {
            scope.ended = true
          } else {
            scope.expressionBodyStarted = true
          }
        } else if (scope.mode === 'pending') {
          const previousSignatureHasWhereClause = scope.pendingHasWhereClause ?? false
          const previousSignatureEndedWithSemicolon = scope.pendingSignatureEndedWithSemicolon ?? false
          const scalaRefinementHeader = lang?.name === 'scala' && isScalaRefinementHeader(scope.symbol, lang)
          const closesScalaRefinement = scalaRefinementHeader
            && braceDepth > scope.baseDepth
            && braceDepth + braceBalanceAtLine[i]! <= scope.baseDepth
          scope.pendingHasWhereClause = previousSignatureHasWhereClause || /\bwhere\b/.test(line)
          if (line.trim().length > 0) {
            scope.pendingSignatureEndedWithSemicolon = /;\s*$/.test(line.trim())
          }
          if (braceDepth > scope.baseDepth && !closesScalaRefinement) continue
          if (closesScalaRefinement) {
            const refinementLine = stripInlineComments(line, lang!).trim()
            if (/^\}+(?:\s*)=/.test(refinementLine)) {
              scope.mode = 'expression'
              scope.expressionBodyStarted = /^\}+(?:\s*)=\s*\S/.test(refinementLine)
            }
            continue
          }
          if (braceDepth + braceBalanceAtLine[i]! < scope.baseDepth) {
            scope.ended = true
            continue
          }
          let previousSignatureLine = i - 1
          while (
            previousSignatureLine >= 0
            && (lines[previousSignatureLine]!.trim().length === 0
              || rubyEmbeddedDocLines[previousSignatureLine]
              || isCommentLine(lines[previousSignatureLine]!, lang, blockCommentDepthAtLineStart[previousSignatureLine]!))
          ) previousSignatureLine--
          const typescriptReturnTypeStartsHere = lang?.name === 'typescript'
            && previousSignatureLine >= 0
            && stripInlineComments(lines[previousSignatureLine]!, lang).trimEnd().endsWith(')')
            && /^:/.test(stripInlineComments(line, lang).trim())
          if (typescriptReturnTypeStartsHere) continue
          const pendingTypeScriptReturnType = lang?.name === 'typescript' && scope.symbol.trimEnd().endsWith(':')
          if (pendingTypeScriptReturnType) {
            let firstReturnTypeLine = scope.startLine + 1
            while (
              firstReturnTypeLine < n
              && (lines[firstReturnTypeLine]!.trim().length === 0 || isCommentLine(lines[firstReturnTypeLine]!, lang, blockCommentDepthAtLineStart[firstReturnTypeLine]!))
            ) firstReturnTypeLine++
            if (i === firstReturnTypeLine) continue
          }
          if (lang?.name === 'typescript' && lexicalState.parenDepth > scope.baseParenDepth) continue
          let signatureThroughLine: string | undefined
          const getSignatureThroughLine = (): string => {
            signatureThroughLine ??= lines.slice(scope.startLine, i + 1).join('\n')
            return signatureThroughLine
          }
          let signatureBeforeLine: string | undefined
          const getSignatureBeforeLine = (): string => {
            signatureBeforeLine ??= lines.slice(scope.startLine, i).join('\n')
            return signatureBeforeLine
          }
          const genericReturnType = (lang?.name === 'kotlin' || lang?.name === 'scala')
            ? lexicalState.parenDepth <= scope.baseParenDepth
              ? genericReturnTypeStatus(getSignatureThroughLine(), lang)
              : null
            : null
          if (genericReturnType === 'incomplete') continue
          if (genericReturnType === 'complete') {
            if (lang?.name === 'scala') {
              const signature = getSignatureThroughLine()
              const bodyEquals = scalaExpressionBodyEquals(signature, lang)
              if (bodyEquals !== null) {
                scope.mode = 'expression'
                scope.expressionBodyStarted = signature.slice(bodyEquals + 1).trim().length > 0
                continue
              }
            }
            const currentSignatureCode = stripInlineComments(line, lang!).trim()
            if (currentSignatureCode.includes('{')) {
              scope.mode = 'brace'
              scope.hasBody = false
            } else if (/(?:>|\])\s*=/.test(currentSignatureCode)) {
              scope.mode = 'expression'
              scope.expressionBodyStarted = /(?:>|\])\s*=\s*\S/.test(currentSignatureCode)
            } else if (boundary[i] && symAt[i]!.length > 0) {
              scope.ended = true
            }
            continue
          }
          const expressionBody = (lang?.name === 'kotlin' || lang?.name === 'scala') && /^=/.test(line.trim())
          if (expressionBody) {
            scope.mode = 'expression'
            scope.expressionBodyStarted = /^=\s*\S/.test(line.trim())
            continue
          }
          const currentSignatureCode = stripInlineComments(line, lang!).trim()
          if (
            lang?.name === 'typescript'
            && braceBalanceAtLine[i]! > 0
            && !hasPendingTypeScriptObjectReturn(getSignatureThroughLine(), lang)
            && symbolBraceOpensBody(getSignatureThroughLine(), lang, true)
          ) {
            scope.mode = 'brace'
            scope.hasBody = false
            continue
          }
          if (
            lang?.name === 'typescript'
            && (
              hasIncompleteTypeScriptReturnType(getSignatureBeforeLine(), lang)
              || hasIncompleteTypeScriptReturnType(getSignatureThroughLine(), lang)
              || hasPendingTypeScriptObjectReturn(getSignatureThroughLine(), lang)
            )
          ) continue
          if (
            lang?.name === 'typescript'
            && isSplitAmbientTypeScriptFunction(scope.symbol, lang)
          ) {
            if (currentSignatureCode.startsWith('(') || lexicalState.parenDepth > scope.baseParenDepth) continue
            scope.ended = true
            continue
          }
          const startsNextSymbol = boundary[i] && symAt[i]!.length > 0
          const objectiveCMethodScope = lang?.name === 'objectivec' && /^[-+]\s*\(/.test(scope.symbol.trim())
          if (objectiveCMethodScope) {
            if (startsNextSymbol || previousSignatureEndedWithSemicolon) {
              scope.ended = true
              continue
            }
            if (currentSignatureCode.includes('{')) {
              scope.mode = 'brace'
              scope.hasBody = false
            }
            continue
          }
          const whereClauseContinuation = (lang?.name === 'rust' || lang?.name === 'kotlin')
            && (
              /^where\b/.test(currentSignatureCode)
              || (previousSignatureHasWhereClause
                && !(lang.name === 'rust' && previousSignatureEndedWithSemicolon))
            )
          const scalaParameterContinuation = lang?.name === 'scala' && /^\(/.test(currentSignatureCode)
          if (
            !startsNextSymbol
            && !currentSignatureCode.includes('{')
            && (whereClauseContinuation || scalaParameterContinuation)
          ) continue
          const previousSignatureCode = previousSignatureLine >= 0
            ? lang
              ? stripInlineComments(lines[previousSignatureLine]!, lang).trim()
              : lines[previousSignatureLine]!.trim()
            : ''
          const swiftResultTypeContinuation = lang?.name === 'swift'
            && previousSignatureLine >= 0
            && !startsNextSymbol
            && (
              previousSignatureCode.endsWith('->')
              || previousSignatureCode.endsWith('&')
              || currentSignatureCode.startsWith('&')
              || (currentSignatureCode.startsWith('{') && getSignatureBeforeLine().includes('->'))
            )
          const rustReturnTypeContinuation = lang?.name === 'rust'
            && lexicalState.parenDepth <= scope.baseParenDepth
            && !previousSignatureEndedWithSemicolon
            && /\bfn\b[\s\S]*\)\s*->/.test(`${getSignatureBeforeLine()}\n${currentSignatureCode}`)
          if (!startsNextSymbol && rustReturnTypeContinuation) {
            if (currentSignatureCode.includes('{')) {
              scope.mode = 'brace'
              scope.hasBody = false
            }
            continue
          }
          const swiftSignatureClause = lang?.name === 'swift'
            && /^(?:async|throws|rethrows)\b|^->|^where\b/.test(stripInlineComments(line, lang).trim())
          if (swiftSignatureClause || swiftResultTypeContinuation) {
            if (swiftResultTypeContinuation && /\{\s*$/.test(line.trim())) {
              scope.mode = 'brace'
              scope.hasBody = false
            }
            continue
          }
          if (/^\s*\{/.test(line) && lexicalState.parenDepth <= scope.baseParenDepth) scope.mode = 'brace'
          else if (lexicalState.parenDepth <= scope.baseParenDepth) scope.ended = true
        }
      }
      while (scopes.at(-1)?.ended) {
        flush(start, i, currentSymbol())
        start = i
        scopes.pop()
      }
    }

    const depthBefore = braceDepth
    const parenDepthBefore = lexicalState.parenDepth
    const bracketDepthBefore = lexicalState.bracketDepth
    const rubyLine = lang?.name === 'ruby' ? rubyBlockDelta(line, lexicalState, lang) : null
    const rubyDelta = rubyLine?.delta ?? 0
    if (rubyLine?.endlessMethodContinuation && scopes.at(-1)?.mode === 'ruby') {
      scopes.at(-1)!.mode = 'expression'
      scopes.at(-1)!.expressionBodyStarted = false
    }
    const scan = braceDelta(
      lang?.name === 'cpp' ? braceLines[i]! : rubyLine?.code ?? line,
      lexicalState,
      lang,
    )
    if (rubyLine) lexicalState.rubyHeredocs.push(...rubyLine.heredocs)
    braceDepth += scan.balance

    for (const scope of scopes) {
      if (
        scope.mode === 'pending'
        && scan.opens
        && parenDepthBefore > scope.baseParenDepth
        && lexicalState.parenDepth <= scope.baseParenDepth
        && (lang?.name !== 'kotlin'
          || symbolBraceOpensBody(lines.slice(scope.startLine, i + 1).join('\n'), lang, scan.opens))
        && (lang?.name !== 'typescript'
          || (
            !hasPendingTypeScriptObjectReturn(lines.slice(scope.startLine, i + 1).join('\n'), lang)
            && symbolBraceOpensBody(lines.slice(scope.startLine, i + 1).join('\n'), lang, scan.opens)
          ))
      ) {
        scope.mode = 'brace'
        scope.hasBody = true
      }
      if (scope.mode === 'indent' && scope.pythonHeaderPending) {
        const header = scanPythonHeader(line, scope.pythonHeaderState)
        scope.pythonHeaderState = header
        if (header.hasTopLevelColon) scope.pythonHeaderPending = false
      }
      if (scope.mode === 'ruby') {
        scope.rubyDepth += rubyDelta
        if (scope.rubyDepth <= 0) scope.ended = true
      } else if (scope.mode === 'expression' && lang?.name === 'ruby') {
        scope.rubyDepth += rubyDelta
      } else if (scope.mode === 'objc') {
        if (
          lang?.name === 'objectivec'
          && !isObjectiveCPreprocessorDirective(lines, i, lang)
          && objectiveCEndsScope(
          line,
          blockCommentDepthAtLineStart[i]!,
          quoteAtLineStart,
          escapedAtLineStart,
          )
        ) scope.ended = true
      } else if (scope.mode === 'brace') {
        if (!scope.hasBody && scan.opens) scope.hasBody = true
        if (scope.hasBody && braceDepth <= scope.baseDepth) scope.ended = true
      }
    }

    if (boundary[i] && i > start) {
      flush(start, i, currentSymbol())
      start = i
    }
    if (boundary[i]) {
      const symbolOpensBody = symbolBraceOpensBody(lines[i]!, lang, scan.opens)
      const bodylessTypeScriptFunction = isBodylessTypeScriptFunction(
        lines,
        i,
        lines[i]!,
        symbolOpensBody,
        lang,
      )
      const pendingTypeScriptReturn = lang?.name === 'typescript'
        && bodylessTypeScriptFunction
        && hasIncompleteTypeScriptReturnType(lines[i]!, lang)
      const splitTypeScriptObjectReturn = hasSplitTypeScriptObjectReturn(
        lines,
        i,
        lines[i]!,
        lang,
      )
      const nextCodeLine = lang === null ? undefined : nextCodeLineAfterComments(
        lines,
        i + 1,
        lang,
        lexicalState.blockCommentDepth,
        nextCodeLineCache,
      )?.code
      const mode = kotlinAnnotationBoundary[i]
        ? 'pending'
        : pendingTypeScriptReturn || splitTypeScriptObjectReturn
        ? 'pending'
        : bodylessTypeScriptFunction
        ? 'line'
        : symbolMode(lines[i]!, lang, symbolOpensBody, nextCodeLine)
      const isPythonHeader =
        mode === 'indent' && /^(?:async\s+)?(?:def|class)\b/.test(lines[i]!.trim())
    const pythonHeader = isPythonHeader
      ? scanPythonHeader(lines[i]!)
      : {
        depth: 0,
        quote: null,
        quoteLength: 0 as const,
        hasTopLevelColon: false,
        topLevelColonIndex: null,
      }
      scopes.push({
        symbol: symAt[i]!,
        baseDepth: depthBefore,
        baseIndent: indent,
        startLine: i,
        mode,
        hasBody: mode === 'brace' && symbolOpensBody,
        expressionBodyStarted: mode === 'expression' && expressionBodyStartsOnLine(lines[i]!, lang),
        pythonHeaderPending: isPythonHeader && !pythonHeader.hasTopLevelColon,
        pythonHeaderState: {
          depth: pythonHeader.depth,
          quote: pythonHeader.quote,
          quoteLength: pythonHeader.quoteLength,
        },
        pendingHasWhereClause: /\bwhere\b/.test(lines[i]!),
        pendingSignatureEndedWithSemicolon: /;\s*$/.test(lines[i]!.trim()),
        baseParenDepth: parenDepthBefore,
        baseBracketDepth: bracketDepthBefore,
        rubyDepth: mode === 'ruby' ? Math.max(0, rubyDelta) : lang?.name === 'ruby' && mode === 'expression' ? rubyDelta : 0,
        ended: mode === 'line' || (lang?.name === 'ruby' && mode === 'ruby' && rubyDelta <= 0),
      })
      const scope = scopes.at(-1)!
      if (
        scope.mode === 'objc'
        && lang?.name === 'objectivec'
        && !isObjectiveCPreprocessorDirective(lines, i, lang)
        && objectiveCEndsScope(
          line,
          blockCommentDepthAtLineStart[i]!,
          quoteAtLineStart,
          escapedAtLineStart,
        )
      ) {
        scope.ended = true
      }
      if (scope.mode === 'brace' && scope.hasBody && braceDepth <= scope.baseDepth) scope.ended = true
    }

    if (i - start + 1 > maxLines) {
      let cutAt = i - 1
      for (let j = i - 1; j >= start + Math.floor(maxLines / 2); j--) {
        if (isBlankish(lines[j]!)) {
          cutAt = j
          break
        }
      }
      flush(start, cutAt + 1, currentSymbol())
      start = cutAt + 1
    }
    if (nonBlank && !rubyEmbeddedDocLine && !languageCommentLine) previousNonCommentLine = i
  }
  flush(start, n, currentSymbol())
  return chunks
}

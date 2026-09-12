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

function isCommentLine(line: string, lang: LanguageDef | null): boolean {
  if (!lang) return false
  const t = line.trimStart()
  for (const prefix of lang.commentPrefixes) {
    if (t.startsWith(prefix)) return true
  }
  return false
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
  const rawTokens = /(?<![A-Za-z0-9_])(?:u8|u|U|L)?R"([^ ()\\\t\v\f\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/(?:(?:[^\n]*?)\\\n)*[^\n]*/g
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
  const tokens = /R"([^ ()\\\t\v\f\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
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

type QuoteKind = "'" | '"' | null

interface TemplateState {
  inExpression: boolean
  expressionDepth: number
  escaped: boolean
}

interface RubyHeredocState {
  delimiter: string
  allowIndent: boolean
}

interface LexicalState {
  blockCommentDepth: number
  quote: QuoteKind
  escaped: boolean
  regex: boolean
  regexClass: boolean
  regexEscaped: boolean
  templates: TemplateState[]
  canStartRegex: boolean
  parenDepth: number
  bracketDepth: number
  shellParameterDepth: number
  rubyHeredocs: RubyHeredocState[]
}

interface BraceScan {
  balance: number
  opens: boolean
}

interface SymbolScope {
  symbol: string
  baseDepth: number
  baseIndent: number
  startLine: number
  mode: 'brace' | 'line' | 'expression' | 'indent' | 'ruby' | 'persistent'
  hasBody: boolean
  expressionBodyStarted: boolean
  pythonHeaderPending: boolean
  pythonHeaderDepth: number
  baseParenDepth: number
  baseBracketDepth: number
  rubyDepth: number
  ended: boolean
}

const REGEX_PREFIX_WORDS = new Set(['case', 'delete', 'else', 'in', 'of', 'return', 'throw', 'typeof', 'void', 'yield'])
const REGEX_PREFIX_CHARS = new Set(['!', '&', '(', '*', '+', ',', '-', '/', ':', ';', '<', '=', '?', '[', '^', '{', '|', '~'])

function newLexicalState(): LexicalState {
  return {
    blockCommentDepth: 0,
    quote: null,
    escaped: false,
    regex: false,
    regexClass: false,
    regexEscaped: false,
    templates: [],
    canStartRegex: true,
    parenDepth: 0,
    bracketDepth: 0,
    shellParameterDepth: 0,
    rubyHeredocs: [],
  }
}

function supportsNestedBlockComments(lang: LanguageDef | null): boolean {
  return lang !== null && ['kotlin', 'rust', 'scala', 'swift'].includes(lang.name)
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
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

interface PythonHeaderScan {
  depth: number
  hasTopLevelColon: boolean
}

function scanPythonHeader(line: string, initialDepth = 0): PythonHeaderScan {
  const code = stripPythonComment(line)
  let depth = initialDepth
  let quote: QuoteKind = null
  let escaped = false
  let hasTopLevelColon = false
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1)
    } else if (ch === ':' && depth === 0) {
      hasTopLevelColon = true
    }
  }
  return { depth, hasTopLevelColon }
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
  return (previous === ')' || previous === ']' || previous === '}') && nextNonWhitespace(line, index) === '/'
}

function isRubyRegexStart(code: string): boolean {
  const trimmed = code.trimEnd()
  if (trimmed.length === 0) return true
  const last = trimmed.at(-1)!
  if ('=([{,:;!&|?+-*%^~<>'.includes(last)) return true
  const word = trimmed.match(/([A-Za-z_]\w*)$/)?.[1]
  return word !== undefined && new Set(['and', 'begin', 'case', 'do', 'else', 'if', 'not', 'or', 'return', 'then', 'unless', 'until', 'when', 'while']).has(word)
}

function skipRubyDelimited(line: string, start: number, opener: string): number {
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')', '<': '>' }
  const closer = pairs[opener] ?? opener
  const paired = closer !== opener
  let depth = paired ? 1 : 0
  let escaped = false
  let inClass = false
  for (let i = start + 1; i < line.length; i++) {
    const ch = line[i]!
    if (escaped) {
      escaped = false
    } else if (ch === '\\') {
      escaped = true
    } else if (opener === '/' && inClass) {
      if (ch === ']') inClass = false
    } else if (opener === '/' && ch === '[') {
      inClass = true
    } else if (paired && ch === opener) {
      depth++
    } else if (ch === closer) {
      if (!paired || --depth === 0) return i
    }
  }
  return line.length
}

function rubyCodeWithoutLiterals(line: string): string {
  let code = ''
  let quote: QuoteKind = null
  let escaped = false
  let regex = false
  let regexClass = false
  let regexEscaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        quote = null
      }
      code += ' '
      continue
    }
    if (regex) {
      if (regexEscaped) {
        regexEscaped = false
      } else if (ch === '\\') {
        regexEscaped = true
      } else if (regexClass) {
        if (ch === ']') regexClass = false
      } else if (ch === '[') {
        regexClass = true
      } else if (ch === '/') {
        regex = false
      }
      code += ' '
      continue
    }
    if (ch === '#') break
    if (ch === '"' || ch === "'") {
      quote = ch
      code += ' '
      continue
    }
    if (ch === '/' && isRubyRegexStart(code)) {
      regex = true
      regexClass = false
      regexEscaped = false
      code += ' '
      continue
    }
    if (ch === '%' && line[i + 1] === 'r') {
      const opener = line[i + 2]
      if (opener !== undefined && '{}[]()<>'.includes(opener)) {
        i = skipRubyDelimited(line, i + 2, opener)
        code += ' '
        continue
      }
    }
    code += ch
  }
  return code
}

function rubyHeredocOpeners(line: string): RubyHeredocState[] {
  const openers: RubyHeredocState[] = []
  const pattern = /<<([~-]?)(?:(["'`])([^"'`\s]+)\2|([A-Za-z_]\w*))/g
  for (const match of line.matchAll(pattern)) {
    const delimiter = match[3] ?? match[4]
    if (delimiter !== undefined) openers.push({ delimiter, allowIndent: match[1] === '-' || match[1] === '~' })
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

/** Count block braces while preserving lexical state between source lines. */
function braceDelta(line: string, state: LexicalState, lang: LanguageDef | null): BraceScan {
  if (lang?.name === 'ruby' && state.rubyHeredocs.length > 0) return { balance: 0, opens: false }
  let balance = 0
  let opens = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
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

    if (state.quote !== null) {
      if (state.escaped) {
        state.escaped = false
      } else if (ch === '\\') {
        state.escaped = true
      } else if (ch === state.quote) {
        state.quote = null
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
      if (template.escaped) {
        template.escaped = false
      } else if (ch === '\\') {
        template.escaped = true
      } else if (ch === '`') {
        state.templates.pop()
        state.canStartRegex = false
      } else if (ch === '$' && line[i + 1] === '{') {
        template.inExpression = true
        template.expressionDepth = 1
        state.canStartRegex = true
        i++
      }
      continue
    }

    if (template?.inExpression) {
      if (ch === '{') {
        template.expressionDepth++
        balance++
        opens = true
        state.canStartRegex = true
        continue
      }
      if (ch === '}') {
        if (template.expressionDepth > 1) {
          template.expressionDepth--
          balance--
          state.canStartRegex = true
        } else {
          template.inExpression = false
          state.canStartRegex = false
        }
        continue
      }
    }

    if (ch === '/' && line[i + 1] === '*') {
      state.blockCommentDepth = 1
      i++
      continue
    }
    if (ch === '/' && line[i + 1] === '/') break
    if (
      ch === '#' &&
      lang?.commentPrefixes.includes('#') &&
      !(lang.name === 'bash' && state.shellParameterDepth > 0)
    ) break
    if (lang?.name === 'bash' && ch === '$' && line[i + 1] === '{') {
      state.shellParameterDepth++
    }
    if (ch === '"' || ch === "'") {
      state.quote = ch
      state.escaped = false
      state.canStartRegex = false
      continue
    }
    if (ch === '`') {
      state.templates.push({ inExpression: false, expressionDepth: 0, escaped: false })
      state.canStartRegex = false
      continue
    }
    if (
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
    if (ch === '{') {
      balance++
      opens = true
      state.canStartRegex = true
    } else if (ch === '}') {
      balance--
      if (lang?.name === 'bash' && state.shellParameterDepth > 0) state.shellParameterDepth--
      state.canStartRegex = true
    } else if (ch === ')' || ch === '(') {
      if (ch === '(') state.parenDepth++
      else state.parenDepth = Math.max(0, state.parenDepth - 1)
      state.canStartRegex = true
    } else if (ch === '[' || ch === ']') {
      if (ch === '[') state.bracketDepth++
      else state.bracketDepth = Math.max(0, state.bracketDepth - 1)
      state.canStartRegex = true
    } else if (/\s/.test(ch)) {
      continue
    } else if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1
      while (end < line.length && /[\w$]/.test(line[end]!)) end++
      state.canStartRegex = REGEX_PREFIX_WORDS.has(line.slice(i, end))
      i = end - 1
    } else if (/[0-9]/.test(ch)) {
      state.canStartRegex = false
    } else {
      state.canStartRegex = REGEX_PREFIX_CHARS.has(ch)
    }
  }
  return { balance, opens }
}

function usesBraceScopes(lang: LanguageDef | null): boolean {
  if (!lang) return false
  return !['python', 'ruby'].includes(lang.name)
}

function symbolEndsOnLine(line: string, lang: LanguageDef | null, opensBrace: boolean): boolean {
  if (!lang) return false
  const trimmed = line.trim()
  const code = lang.name === 'python' ? stripPythonComment(line).trim() : trimmed
  if (lang.name === 'python' && /^(?:async\s+)?(?:def|class)\b.*:\s*\S/.test(code)) return true
  if (lang.name === 'ruby' && /^(?:class|module|def)\b.*(?:;\s*end|=\s*\S)/.test(trimmed)) return true
  if (opensBrace) return false
  if (isBodylessDeclaration(code, lang)) return true
  if (trimmed.endsWith(';')) return true
  if (lang.name === 'javascript' || lang.name === 'typescript') {
    if (/^\s*(?:export\s+)?type\b.*=\s*\S/.test(code)) return true
    return /=>/.test(code) && !/=>\s*$/.test(code)
  }
  if (lang.name === 'kotlin') return /\bfun\b.*=\s*\S/.test(code)
  if (lang.name === 'scala') return /\bdef\b.*=\s*\S/.test(code)
  return false
}

function isBodylessDeclaration(line: string, lang: LanguageDef): boolean {
  if (/[={}]/.test(line) || /=/.test(line)) return false
  if (lang.name === 'kotlin') return /\bfun\b.*\)\s*(?::\s*[^=]+)?$/.test(line)
  if (lang.name === 'scala') return /\bdef\b.*(?:\)\s*(?::\s*[^=]+)?|:\s*[^=]+)$/.test(line)
  if (lang.name === 'swift') return /\bfunc\b.*\)\s*(?:->\s*[\w<>,.?[\] ]+)?$/.test(line)
  return false
}

function expressionSymbol(line: string, lang: LanguageDef | null): boolean {
  if (!lang) return false
  const trimmed = line.trim()
  if (lang.name === 'javascript' || lang.name === 'typescript') {
    return /=>\s*$/.test(trimmed) || /^\s*(?:export\s+)?type\b.*=\s*$/.test(trimmed)
  }
  if (lang.name === 'kotlin') return /\bfun\b.*=\s*$/.test(trimmed)
  if (lang.name === 'scala') return /\bdef\b.*=\s*$/.test(trimmed)
  return false
}

function isTopLevelStatementStart(line: string, lang: LanguageDef | null): boolean {
  if (!lang) return false
  const trimmed = line.trim()
  if (trimmed.length === 0 || isCommentLine(line, lang)) return false
  if (lang.name === 'javascript' || lang.name === 'typescript') {
    return /^(?:export\s+)?(?:const|let|var|function|class|interface|type|enum|namespace|module|import|return|throw|if|for|while|switch|try)\b/.test(trimmed)
  }
  if (lang.name === 'kotlin') {
    return /^(?:(?:public|private|protected|internal|open|abstract|sealed|data|inline|suspend)\s+)*(?:val|var|fun|class|interface|enum|object|typealias|import|package)\b/.test(trimmed)
  }
  if (lang.name === 'scala') {
    return /^(?:(?:private|protected|implicit|final|sealed|abstract|override)\s+)*(?:val|var|def|class|object|trait|enum|type|import|package)\b/.test(trimmed)
  }
  return false
}

function symbolMode(line: string, lang: LanguageDef | null, opensBrace: boolean): SymbolScope['mode'] {
  if (!lang) return 'persistent'
  if (lang.name === 'python') return symbolEndsOnLine(line, lang, opensBrace) ? 'line' : 'indent'
  if (lang.name === 'ruby') {
    if (symbolEndsOnLine(line, lang, opensBrace)) return 'line'
    return /^(?:class|module|def)\b/.test(line.trim()) ? 'ruby' : 'line'
  }
  if (!usesBraceScopes(lang)) return 'persistent'
  if (symbolEndsOnLine(line, lang, opensBrace)) return 'line'
  if (expressionSymbol(line, lang)) return 'expression'
  return 'brace'
}

function leadingIndent(line: string): number {
  const prefix = line.match(/^[ \t]*/)?.[0] ?? ''
  return prefix.replace(/\t/g, '    ').length
}

function rubyBlockDelta(line: string, state: LexicalState): number {
  if (rubyHeredocLine(line, state)) return 0
  const code = rubyCodeWithoutLiterals(line)
  const endlessMethod = /^\s*def\b.*=\s*\S/.test(code)
  const opens =
    (code.match(/(?:^|;)\s*(?:class|module|def|if|unless|case|begin|while|until|for)\b/g)?.length ?? 0) +
    (code.match(/\bdo\b/g)?.length ?? 0)
  const closes = code.match(/\bend\b/g)?.length ?? 0
  state.rubyHeredocs.push(...rubyHeredocOpeners(code))
  return opens - closes - (endlessMethod ? 1 : 0)
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
  for (let i = 0; i < n; i++) {
    if (!lang) continue
    const line = lines[i]!
    const structuralLine = structuralLines[i]!
    const inRubyHeredoc = lang.name === 'ruby' && boundaryLexicalState.rubyHeredocs.length > 0
    const physicalLinkageLine = linkageLines[i]!
    const linkageLine = i < n - 1 && structuralLine.endsWith('\\')
      ? physicalLinkageLine.slice(0, -1)
      : physicalLinkageLine
    const isDirective = lang.name === 'cpp' && (inDirectiveContinuation || structuralLine.trimStart().startsWith('#'))
    if (isDirective) {
      inDirectiveContinuation = /\\\s*$/.test(line)
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
    let symbol = lang.name === 'cpp'
      ? matchSymbol(declarationLine, lang, inCLinkageBlock, allowExtern, inCppClassScope, inCppNamespaceOrFileScope, cppClassName)
      : boundaryLexicalState.blockCommentDepth === 0
        && boundaryLexicalState.quote === null
        && !boundaryLexicalState.regex
        && boundaryLexicalState.templates.length === 0
        && !inRubyHeredoc
        ? matchSymbol(line, lang)
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
    if (lang.name === 'ruby') rubyBlockDelta(line, boundaryLexicalState)
    braceDelta(lang.name === 'cpp' ? structuralLine : line, boundaryLexicalState, lang)
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
  const scopes: SymbolScope[] = []
  const currentSymbol = (): string => scopes.at(-1)?.symbol ?? ''
  for (let i = 0; i < n; i++) {
    const line = lines[i]!
    const nonBlank = line.trim().length > 0
    const structuralLine = nonBlank && !isCommentLine(line, lang)
    const indent = leadingIndent(line)

    // Keep trailing blank lines with the completed scope, but stop carrying it
    // into the next non-blank statement and restore its enclosing scope.
    if (structuralLine) {
      for (const scope of scopes) {
        if (i <= scope.startLine) continue
        if (scope.mode === 'indent') {
          if (scope.pythonHeaderPending) continue
          if (indent <= scope.baseIndent) scope.ended = true
        } else if (scope.mode === 'expression') {
          const expressionContinues =
            braceDepth > scope.baseDepth ||
            lexicalState.parenDepth > scope.baseParenDepth ||
            lexicalState.bracketDepth > scope.baseBracketDepth
          const startsStatement = indent <= scope.baseIndent && isTopLevelStatementStart(line, lang)
          if (startsStatement && !expressionContinues) {
            scope.ended = true
          } else {
            scope.expressionBodyStarted = true
          }
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
    const rubyDelta = lang?.name === 'ruby' ? rubyBlockDelta(line, lexicalState) : 0
    const scan = braceDelta(lang?.name === 'cpp' ? structuralLines[i]! : line, lexicalState, lang)
    braceDepth += scan.balance

    for (const scope of scopes) {
      if (scope.mode === 'indent' && scope.pythonHeaderPending) {
        const header = scanPythonHeader(line, scope.pythonHeaderDepth)
        scope.pythonHeaderDepth = header.depth
        if (header.hasTopLevelColon) scope.pythonHeaderPending = false
      }
      if (scope.mode === 'ruby') {
        scope.rubyDepth += rubyDelta
        if (scope.rubyDepth <= 0) scope.ended = true
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
      const mode = symbolMode(lines[i]!, lang, scan.opens)
      const isPythonHeader =
        mode === 'indent' && /^(?:async\s+)?(?:def|class)\b/.test(lines[i]!.trim())
      const pythonHeader = isPythonHeader ? scanPythonHeader(lines[i]!) : { depth: 0, hasTopLevelColon: false }
      scopes.push({
        symbol: symAt[i]!,
        baseDepth: depthBefore,
        baseIndent: indent,
        startLine: i,
        mode,
        hasBody: mode === 'brace' && scan.opens,
        expressionBodyStarted: false,
        pythonHeaderPending: isPythonHeader && !pythonHeader.hasTopLevelColon,
        pythonHeaderDepth: pythonHeader.depth,
        baseParenDepth: parenDepthBefore,
        baseBracketDepth: bracketDepthBefore,
        rubyDepth: mode === 'ruby' ? 1 : 0,
        ended: mode === 'line',
      })
      const scope = scopes.at(-1)!
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
  }
  flush(start, n, currentSymbol())
  return chunks
}

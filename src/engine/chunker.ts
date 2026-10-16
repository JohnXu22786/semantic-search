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
  const n = lines.length
  if (n === 0) return []

  const maxLines = Math.max(1, Math.floor(opts.maxLines))

  // Pass 1: boundary detection with symbol propagation.
  const boundary = new Array<boolean>(n).fill(false)
  const symAt = new Array<string>(n).fill('')
  const boundaryLexicalState = newLexicalState()
  for (let i = 0; i < n; i++) {
    const inRubyHeredoc = lang?.name === 'ruby' && boundaryLexicalState.rubyHeredocs.length > 0
    if (
      lang &&
      boundaryLexicalState.blockCommentDepth === 0 &&
      boundaryLexicalState.quote === null &&
      !boundaryLexicalState.regex &&
      boundaryLexicalState.templates.length === 0 &&
      !inRubyHeredoc
    ) {
      const symbol = matchSymbol(lines[i]!, lang)
      if (symbol.length > 0) {
        boundary[i] = true
        symAt[i] = symbol
      }
    }
    if (lang?.name === 'ruby') rubyBlockDelta(lines[i]!, boundaryLexicalState)
    braceDelta(lines[i]!, boundaryLexicalState, lang)
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
    const scan = braceDelta(line, lexicalState, lang)
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

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

interface LexicalState {
  blockCommentDepth: number
  quote: QuoteKind
  escaped: boolean
  regex: boolean
  regexClass: boolean
  regexEscaped: boolean
  templates: TemplateState[]
  canStartRegex: boolean
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
  rubyDepth: number
  ended: boolean
}

const REGEX_PREFIX_WORDS = new Set(['case', 'delete', 'else', 'in', 'of', 'return', 'throw', 'typeof', 'void', 'yield'])
const REGEX_PREFIX_CHARS = new Set(['!', '&', '(', '*', '+', ',', '-', ':', ';', '<', '=', '?', '[', '^', '{', '|', '~'])

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

/** Count block braces while preserving lexical state between source lines. */
function braceDelta(line: string, state: LexicalState, lang: LanguageDef | null): BraceScan {
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
    if (ch === '#' && lang?.commentPrefixes.includes('#')) break
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
    if (ch === '/' && state.canStartRegex && hasRegexTerminator(line, i)) {
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
      state.canStartRegex = true
    } else if (ch === ')' || ch === '(') {
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
  if (lang.name === 'python' && /^(?:async\s+)?(?:def|class)\b.*:\s*\S/.test(trimmed)) return true
  if (lang.name === 'ruby' && /^(?:class|module|def)\b.*(?:;\s*end|=\s*\S)/.test(trimmed)) return true
  if (opensBrace) return false
  if (trimmed.endsWith(';')) return true
  if (lang.name === 'javascript' || lang.name === 'typescript') {
    if (/^\s*(?:export\s+)?type\b.*=\s*\S/.test(trimmed)) return true
    return /=>/.test(trimmed) && !/=>\s*$/.test(trimmed)
  }
  if (lang.name === 'kotlin') return /\bfun\b.*=\s*\S/.test(trimmed)
  if (lang.name === 'scala') return /\bdef\b.*=\s*\S/.test(trimmed)
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

function rubyBlockDelta(line: string): number {
  const code = line
    .replace(/(['"])(?:\\.|(?!\1).)*\1/g, '')
    .replace(/#.*$/, '')
  const endlessMethod = /^\s*def\b.*=\s*\S/.test(code)
  const opens = code.match(/\b(?:class|module|def|if|unless|case|begin|while|until|for|do)\b/g)?.length ?? 0
  const closes = code.match(/\bend\b/g)?.length ?? 0
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
    if (
      lang &&
      boundaryLexicalState.blockCommentDepth === 0 &&
      boundaryLexicalState.quote === null &&
      !boundaryLexicalState.regex &&
      boundaryLexicalState.templates.length === 0
    ) {
      const symbol = matchSymbol(lines[i]!, lang)
      if (symbol.length > 0) {
        boundary[i] = true
        symAt[i] = symbol
      }
    }
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
    const indent = leadingIndent(line)

    // Keep trailing blank lines with the completed scope, but stop carrying it
    // into the next non-blank statement and restore its enclosing scope.
    if (nonBlank) {
      for (const scope of scopes) {
        if (i <= scope.startLine) continue
        if (scope.mode === 'indent' && indent <= scope.baseIndent) {
          scope.ended = true
        } else if (scope.mode === 'expression') {
          if (!scope.expressionBodyStarted) {
            if (indent <= scope.baseIndent) scope.ended = true
            else scope.expressionBodyStarted = true
          } else if (indent <= scope.baseIndent) {
            scope.ended = true
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
    const rubyDelta = lang?.name === 'ruby' ? rubyBlockDelta(line) : 0
    const scan = braceDelta(line, lexicalState, lang)
    braceDepth += scan.balance

    for (const scope of scopes) {
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
      scopes.push({
        symbol: symAt[i]!,
        baseDepth: depthBefore,
        baseIndent: indent,
        startLine: i,
        mode,
        hasBody: mode === 'brace' && scan.opens,
        expressionBodyStarted: false,
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

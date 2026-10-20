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
    let symbol = matchSymbol(lang.name === 'cpp' ? declarationLine : line, lang, inCLinkageBlock, allowExtern, inCppClassScope, inCppNamespaceOrFileScope, cppClassName)
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
  let symbol = ''
  for (let i = 0; i < n; i++) {
    if (boundary[i] && i > start) {
      flush(start, i, symbol)
      start = i
    }
    if (boundary[i]) symbol = symAt[i]!
    if (i - start + 1 > maxLines) {
      let cutAt = i - 1
      for (let j = i - 1; j >= start + Math.floor(maxLines / 2); j--) {
        if (isBlankish(lines[j]!)) {
          cutAt = j
          break
        }
      }
      flush(start, cutAt + 1, symbol)
      start = cutAt + 1
    }
  }
  flush(start, n, symbol)
  return chunks
}

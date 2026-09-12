/**
 * Language identification and lightweight symbol-boundary extraction.
 *
 * This is intentionally NOT a full parser (no tree-sitter dependency). Each
 * language defines a set of regular expressions that, matched against a single
 * trimmed source line, announce a new symbol (function/class/type/dev) whose
 * body follows. The chunker uses these boundaries to keep functions/classes
 * intact and labels every chunk with its nearest enclosing symbol.
 *
 * The patterns are deliberately conservative: a missed boundary still yields a
 * valid plain-text chunk, so extraction quality degrades gracefully rather
 * than breaking.
 */

export interface LanguageDef {
  name: string
  /** File extensions (lowercased, without the leading dot). */
  extensions: string[]
  /** Regexes matched against a trimmed line to open a new symbol body. */
  symbolPatterns: RegExp[]
  /** Line prefixes that begin a comment; used to pick a good summary line. */
  commentPrefixes: string[]
}

/** A few shared building blocks to keep the table readable. */
const PMP = /^(\bpublic\b|\bprivate\b|\bprotected\b|\binternal\b)\s+/
const STATIC_FINAL = /^((public|private|protected|internal)?\s*)?(static\s+|final\s+|abstract\s+|synchronized\s+|async\s+|override\s+|virtual\s+|sealed\s+)*/
const KW_CLASS = /(class|interface|enum|struct|record|trait|impl|protocol|extension|object|namespace|module|union|type)\b/

/** Conservative C-style function/method shape: `name(...)` followed by `{` or `;`. */
const OPEN_BRACE_RE = /^\s*[A-Za-z_$][\w.$<>[\]?,-]*\s+\w+\s*\([^)]*\)\s*(throws\s+[\w.,\s]+)?\s*[{;]/

const LANGUAGES: LanguageDef[] = [
  {
    name: 'typescript',
    extensions: ['ts', 'tsx', 'mts', 'cts'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [
      /^\s*(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?function\s*[*]?\s*\w/,
      /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+/,
      /^\s*(export\s+)?(abstract\s+)?interface\s+\w+/,
      /^\s*(export\s+)?(type|enum|namespace|module)\s+\w+/,
      /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>/,
      /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?function/,
      /^\s*(export\s+)?abstract\s+class\s+\w+/,
    ],
  },
  {
    name: 'javascript',
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [
      /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*[*]?\s*\w/,
      /^\s*(export\s+)?(default\s+)?class\s+\w+/,
      /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>/,
      /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?function/,
    ],
  },
  {
    name: 'python',
    extensions: ['py', 'pyw'],
    commentPrefixes: ['#'],
    symbolPatterns: [
      /^\s*(async\s+)?def\s+\w+\s*\(/,
      /^\s*class\s+\w+/,
      /^\s*@\w[\w.]*/,
    ],
  },
  {
    name: 'go',
    extensions: ['go'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [/^\s*func\s+/, /^\s*type\s+\w+\s+(struct|interface)\b/],
  },
  {
    name: 'rust',
    extensions: ['rs'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [
      /^\s*(pub(\s*\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+\w+/,
      /^\s*(pub\s+)?(struct|enum|trait|impl|mod|union|type|const|static)\s+\w+/,
      /^\s*(struct|enum|trait|impl|mod|union)\s+\w+/,
    ],
  },
  {
    name: 'java',
    extensions: ['java'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [
      /^\s*(public|private|protected)?\s*(static\s+|final\s+|abstract\s+|synchronized\s+)*(class|interface|enum|record|@interface)\s+\w+/,
      OPEN_BRACE_RE,
    ],
  },
  {
    name: 'kotlin',
    extensions: ['kt', 'kts'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [
      /^\s*(public|private|protected|internal)?\s*(override\s+)?(suspend\s+)?(inline\s+)?(fun|func|class|interface|enum|object|data\s+class|sealed\s+class)\b/,
      /^\s*(fun|func|class|interface|enum|object)\b/,
      OPEN_BRACE_RE,
    ],
  },
  {
    name: 'scala',
    extensions: ['scala', 'sc'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [/^\s*(private|protected)?\s*(def|class|object|trait|enum|case\s+class)\b/],
  },
  {
    name: 'cpp',
    extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'h'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [
      /^\s*(public|private|protected)?\s*(static\s+|virtual\s+|inline\s+|constexpr\s+|friend\s+)*(\b(class|struct|enum|union|namespace|interface)\b)\s+\w+/,
      OPEN_BRACE_RE,
    ],
  },
  {
    name: 'c',
    extensions: ['c', 'h'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [/^\s*(static\s+|inline\s+|extern\s+)*(struct|enum|union)\s+\w+/, OPEN_BRACE_RE],
  },
  {
    name: 'csharp',
    extensions: ['cs'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [
      /^\s*(public|private|protected|internal)\s+(static\s+|virtual\s+|override\s+|abstract\s+|sealed\s+|async\s+|partial\s+)*(class|interface|struct|enum|record|namespace)\s+\w+/,
      OPEN_BRACE_RE,
    ],
  },
  {
    name: 'objectivec',
    extensions: ['m', 'mm'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [
      /^\s*[-+]\s*\([\w\s*<>]+\)\s*\w+/,
      /^\s*@(interface|implementation|protocol)\s+\w+/,
      /^\s*(static\s+)?\w+\s+\w+\s*\([\w\s*<>,\[\]]*\)\s*\{/,
    ],
  },
  {
    name: 'ruby',
    extensions: ['rb'],
    commentPrefixes: ['#'],
    symbolPatterns: [/^\s*(class|module|def|private|protected)\b/],
  },
  {
    name: 'php',
    extensions: ['php'],
    commentPrefixes: ['//', '/*', '*', '#'],
    symbolPatterns: [
      /^\s*(public|private|protected)?\s*(static\s+)?function\s+\w+/,
      /^\s*(function|class|interface|trait|namespace)\s+\w+/,
    ],
  },
  {
    name: 'swift',
    extensions: ['swift'],
    commentPrefixes: ['//', '/*', '*'],
    symbolPatterns: [
      /^\s*(public|private|internal|fileprivate|open)?\s*(static\s+)?(override\s+)?(mutating\s+)?(func|class|struct|enum|protocol|extension)\s+\w+/,
      /^\s*(func|class|struct|enum|protocol|extension)\s+\w+/,
    ],
  },
  {
    name: 'bash',
    extensions: ['sh', 'bash', 'zsh'],
    commentPrefixes: ['#'],
    symbolPatterns: [/^\s*function\s+\w+/, /^\s*\w+\s*\(\)\s*\{/],
  },
]

const EXT_INDEX = new Map<string, LanguageDef>()
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) {
    if (!EXT_INDEX.has(ext)) EXT_INDEX.set(ext, lang)
  }
}

/** Look up the language definition for a file path, or null if unknown. */
export function languageForPath(path: string): LanguageDef | null {
  const idx = path.lastIndexOf('.')
  if (idx < 0) return null
  const ext = path.slice(idx + 1).toLowerCase()
  return EXT_INDEX.get(ext) ?? null
}

/** Whether a file path is recognized as source code by the built-in table. */
export function isKnownSource(path: string): boolean {
  return languageForPath(path) !== null
}

/** Static plugin manifest for docs: the language names we understand. */
export function knownLanguages(): string[] {
  return LANGUAGES.map((lang) => lang.name)
}

/** Every file extension the built-in table understands (unique, sorted). */
export function allExtensions(): string[] {
  const set = new Set<string>()
  for (const lang of LANGUAGES) {
    for (const ext of lang.extensions) set.add(ext)
  }
  return [...set].sort()
}

/**
 * Match one trimmed source line against a language's symbol patterns.
 * Returns the canonical symbol header (with leading indentation removed and
 * internal whitespace collapsed) or an empty string when the line opens no
 * new symbol.
 */
export function matchSymbol(line: string, lang: LanguageDef): string {
  const trimmed = line.trim()
  if (trimmed.length === 0) return ''
  for (const pattern of lang.symbolPatterns) {
    if (pattern.test(trimmed)) return collapseWhitespace(trimmed)
  }
  return ''
}

/** Collapse runs of whitespace (preserving single spaces) and cap length. */
export function collapseWhitespace(line: string, max = 200): string {
  const collapsed = line.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed
}

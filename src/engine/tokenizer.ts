/**
 * Language-aware text tokenization.
 *
 * Handles three token families with one pass:
 *  1. Latin/alphanumeric runs: lowercased, then split on camelCase boundaries
 *     (e.g. `getURL` → `get`, `URL`; `XMLHttpRequest` → `xml`, `http`,
 *     `request`). Underscores/hyphens already separate runs, so snake_case and
 *     kebab-case fall out naturally.
 *  2. CJK runs (CJK ideographs, kana, hangul): emitted as sliding n-grams
 *     (default bigrams) so both query and document see identical tokens
 *     without needing a segmentation library. Full-width/CJK punctuation is
 *     folded (dropped) rather than hard-breaking the run.
 *  3. Everything else (other punctuation, whitespace, operators) is a boundary
 *     and produces nothing.
 */

// CJK-ish character ranges: CJK unified ideographs + extension A, compatibility
// ideographs, kana (hiragana + katakana), and hangul syllables.
const CJK_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/

// Matches a CJK run (letters + folded punctuation) or an alphanumeric run;
// full-width/CJK punctuation, ASCII punctuation/space are boundaries.
const RUN_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF5E]+|[A-Za-z0-9]+/g

// Insert a break between an acronym boundary and a following word boundary:
// `XML`/`Http`, `get`/`URL`. Two lookbehinds handle `getURL` and `XMLHttp`.
const CAMEL_SPLIT_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/

/** Emit sliding n-grams for one CJK run (punctuation characters dropped). */
function pushNgrams(out: string[], run: string, n: number): void {
  const letters = [...run].filter((ch) => CJK_RE.test(ch)).join('')
  if (letters.length === 0) return
  if (letters.length <= n) {
    out.push(letters)
    return
  }
  for (let i = 0; i + n <= letters.length; i++) {
    out.push(letters.slice(i, i + n))
  }
}

/** Emit the split identifier parts of one alphanumeric run, lowercased. */
function pushWord(out: string[], word: string): void {
  for (const part of word.split(CAMEL_SPLIT_RE)) {
    if (part.length > 0) out.push(part.toLocaleLowerCase())
  }
}

/**
 * Tokenize source text. Keeps duplicate tokens (frequency matters for both the
 * BM25 term frequencies and the lexical TF-IDF embedding).
 *
 * @param text  raw source/query text
 * @param ngram CJK n-gram size (2 => bigrams); 1 disables n-gramming.
 */
export function tokenize(text: string, ngram = 2): string[] {
  const out: string[] = []
  const n = Math.max(1, Math.floor(ngram))
  for (const match of text.matchAll(RUN_RE)) {
    const tok = match[0]!
    if (CJK_RE.test(tok)) pushNgrams(out, tok, n)
    else if (/[A-Za-z0-9]/.test(tok)) pushWord(out, tok)
  }
  return out
}

/** Distinct tokens of a text, useful for IDF vocabulary scans. */
export function tokenTypes(text: string, ngram?: number): string[] {
  const seen = new Set<string>()
  for (const tok of tokenize(text, ngram)) seen.add(tok)
  return [...seen]
}

/** Term-frequency map derived from `tokenize`. */
export function termFrequencies(text: string, ngram?: number): Map<string, number> {
  const tf = new Map<string, number>()
  for (const tok of tokenize(text, ngram)) {
    tf.set(tok, (tf.get(tok) ?? 0) + 1)
  }
  return tf
}

/** True when the string contains at least one CJK character. */
export function containsCjk(text: string): boolean {
  return CJK_RE.test(text)
}

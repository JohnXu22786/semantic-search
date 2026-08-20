/**
 * BM25 inverted index (from scratch), used for the lexical retrieval channel.
 *
 * SearchIndex owns the per-chunk term→frequency maps (they are also needed for
 * persistence); this class only owns the inverted postings and document
 * lengths, and both `put`/`remove` receive the term map from the caller. That
 * avoids duplicating the term data in memory.
 */

export interface TermPosting {
  chunk: number
  tf: number
}

export interface Scored {
  chunk: number
  score: number
}

const K1 = 1.2
const B = 0.75

export class LexicalIndex {
  private inverted = new Map<string, TermPosting[]>()
  private docLen = new Map<number, number>()
  private chunkIds = new Set<number>()
  private idf = new Map<string, number>()
  private totalLen = 0
  nDocs = 0
  avgLen = 0

  /** Register a NEW chunk id with its term frequencies. */
  put(chunkId: number, tf: Map<string, number>): void {
    if (this.chunkIds.has(chunkId)) {
      throw new Error(`duplicate chunk id: ${chunkId}`)
    }
    let len = 0
    for (const [term, freq] of tf) {
      if (freq <= 0 || term.length === 0) continue
      len += freq
      let list = this.inverted.get(term)
      if (!list) {
        list = []
        this.inverted.set(term, list)
      }
      list.push({ chunk: chunkId, tf: freq })
    }
    this.chunkIds.add(chunkId)
    this.nDocs++
    this.docLen.set(chunkId, len)
    this.totalLen += len
    this.avgLen = this.nDocs > 0 ? this.totalLen / this.nDocs : 0
  }

  /** Remove an existing chunk id (its term map must be provided). */
  remove(chunkId: number, tf: Map<string, number>): void {
    if (!this.chunkIds.has(chunkId)) return
    for (const term of tf.keys()) {
      const list = this.inverted.get(term)
      if (!list) continue
      const idx = list.findIndex((p) => p.chunk === chunkId)
      if (idx >= 0) {
        list.splice(idx, 1)
        if (list.length === 0) this.inverted.delete(term)
      }
    }
    this.chunkIds.delete(chunkId)
    this.nDocs = Math.max(0, this.nDocs - 1)
    const len = this.docLen.get(chunkId) ?? 0
    this.docLen.delete(chunkId)
    this.totalLen = Math.max(0, this.totalLen - len)
    this.avgLen = this.nDocs > 0 ? this.totalLen / this.nDocs : 0
  }

  /** Recompute IDF from current document frequencies. */
  refreshIdf(): void {
    this.idf.clear()
    const n = this.nDocs
    if (n === 0) return
    for (const [term, postings] of this.inverted) {
      const df = postings.length
      this.idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)))
    }
  }

  /** IDF for a term, or its maximum (as-if unseen) when out of vocabulary. */
  idfOrMax(term: string): number {
    const value = this.idf.get(term)
    if (value !== undefined) return value
    return Math.log(1 + this.nDocs)
  }

  /** Read-only view of the current IDF table (used by the lexical embedder). */
  get idfMap(): ReadonlyMap<string, number> {
    return this.idf
  }

  /** Top-K chunks by BM25 over the given query terms. */
  top(queryTerms: readonly string[], limit: number): Scored[] {
    const acc = new Map<number, number>()
    for (const term of queryTerms) {
      const idf = this.idf.get(term)
      if (idf === undefined) continue
      const postings = this.inverted.get(term)
      if (!postings) continue
      for (const p of postings) {
        const dl = this.docLen.get(p.chunk)
        if (dl === undefined || dl === 0) continue
        const norm = dl / (this.avgLen > 0 ? this.avgLen : 1)
        const contrib = (idf * (p.tf * (K1 + 1))) / (p.tf + K1 * (1 - B + B * norm))
        acc.set(p.chunk, (acc.get(p.chunk) ?? 0) + contrib)
      }
    }
    return [...acc.entries()]
      .map(([chunk, score]) => ({ chunk, score }))
      .sort((a, b) => b.score - a.score || a.chunk - b.chunk)
      .slice(0, Math.max(0, Math.floor(limit)))
  }

  /** Vocabulary size. */
  get terms(): number {
    return this.inverted.size
  }
}

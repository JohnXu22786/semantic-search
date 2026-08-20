/**
 * Hybrid fusion and vector ranking.
 *
 * The two retrieval channels (vector cosine, BM25) are combined with
 * reciprocal-rank fusion (RRF): each candidate gets `1 / (k + rank)` per
 * channel in which it appears, summed across channels. A document found by
 * only one channel still enters the fused list (it contributes that channel's
 * reciprocal), which is what makes hybrid search robust to either channel
 * missing terms or semantic drift.
 */

import { cosine } from './provider.ts'

export interface RankedCandidate {
  /** Chunk id. */
  id: number
  score: number
}

export interface FuseOptions {
  rrfK: number
  topK: number
}

export interface FusedCandidate extends RankedCandidate {
  vectorScore: number | null
  lexicalScore: number | null
}

/** Top-K chunk ids by cosine similarity to a query vector (assumed normalized). */
export function topByCosine(
  entries: Iterable<[number, Float32Array]>,
  query: Float32Array,
  limit: number,
): RankedCandidate[] {
  const results: RankedCandidate[] = []
  for (const [id, vec] of entries) {
    const score = cosine(vec, query)
    if (Number.isFinite(score)) results.push({ id, score })
  }
  results.sort((a, b) => b.score - a.score || a.id - b.id)
  return results.slice(0, Math.max(0, limit))
}

/** Reciprocal-rank fuse two sorted rank lists into a single T-top-K list. */
export function fuse(
  vector: RankedCandidate[],
  lexical: RankedCandidate[],
  opts: FuseOptions,
): FusedCandidate[] {
  const k = Math.max(1, Math.floor(opts.rrfK))
  const acc = new Map<number, { rrf: number; vec: number | null; lex: number | null }>()

  const addChannel = (ranks: RankedCandidate[], channel: 'vec' | 'lex'): void => {
    for (let i = 0; i < ranks.length; i++) {
      const entry = ranks[i]!
      const cur = acc.get(entry.id) ?? { rrf: 0, vec: null, lex: null }
      cur.rrf += 1 / (k + (i + 1))
      if (channel === 'vec') cur.vec = entry.score
      else cur.lex = entry.score
      acc.set(entry.id, cur)
    }
  }

  addChannel(vector, 'vec')
  addChannel(lexical, 'lex')

  return [...acc.entries()]
    .map(([id, v]) => ({
      id,
      score: v.rrf,
      vectorScore: v.vec,
      lexicalScore: v.lex,
    }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, Math.max(0, Math.floor(opts.topK)))
}

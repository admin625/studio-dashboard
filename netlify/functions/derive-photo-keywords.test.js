import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// The function is .cjs (it requires _authz.cjs locally, and a local require in a "type":"module"
// package must stay CommonJS or Netlify drops exports.handler). Load it through createRequire so
// the test exercises the exact module Netlify bundles, not a re-implementation.
const require = createRequire(import.meta.url)
const { splitTerms } = require('./derive-photo-keywords.cjs')

describe('splitTerms — the model-output trust boundary', () => {
  it('keeps a clean comma-delimited list intact', () => {
    expect(splitTerms('reformer, footbar, supine, spring resistance'))
      .toEqual(['reformer', 'footbar', 'supine', 'spring resistance'])
  })

  it('strips a preamble so commentary is never stored as a search term', () => {
    // Without this, "here are the keywords: reformer" becomes a term and matches captions forever.
    expect(splitTerms('Here are the keywords: reformer, footbar, supine'))
      .toEqual(['reformer', 'footbar', 'supine'])
  })

  it('collapses duplicates — they would inflate term_count past the sparse flag', () => {
    expect(splitTerms('reformer, Reformer, reformer, footbar')).toEqual(['reformer', 'footbar'])
  })

  it('drops a term that is really a sentence', () => {
    expect(splitTerms('reformer, this is a very long sentence that describes the scene, footbar'))
      .toEqual(['reformer', 'footbar'])
  })

  it('drops a term over the character ceiling even when it is few words', () => {
    const long = 'a'.repeat(41)
    expect(splitTerms(`reformer, ${long}, footbar`)).toEqual(['reformer', 'footbar'])
  })

  it('normalises case, trailing periods, bullets and empty segments', () => {
    expect(splitTerms('- Reformer, footbar.')).toEqual(['reformer', 'footbar'])
    expect(splitTerms('reformer,,  ,footbar')).toEqual(['reformer', 'footbar'])
  })

  it('returns [] for empty input rather than a one-element blank', () => {
    expect(splitTerms('')).toEqual([])
    expect(splitTerms(null)).toEqual([])
    expect(splitTerms(undefined)).toEqual([])
  })

  it('leaves NOT_A_PHOTOGRAPH as a single term so it lands below the floor of 3', () => {
    // The handler checks the sentinel before splitting, but if that check ever moves, a
    // one-term result is still refused by the floor rather than stored.
    expect(splitTerms('NOT_A_PHOTOGRAPH')).toHaveLength(1)
  })
})

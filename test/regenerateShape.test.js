import { describe, it, expect } from 'vitest'
import { originalShape, describeShape } from '../src/lib/regenerateShape.js'
import { flagReasonLine, regenerateIntroLine } from '../src/lib/qualityFlag.js'

/**
 * UX ruling 2a (Mac 2026-10-08). On 10-06 TLK's 1-post flagged delivery c8787c0a was regenerated
 * through the full Create form at its defaults and came back as 3 posts (17f9fac3). The shape
 * read here is what the Regenerate sheet now asks for.
 */

const post = (o = {}) => ({ caption: 'x', hashtags: '#a', format: 'feed_post', photo_url: null, ...o })

describe('originalShape', () => {
  it("TLK c8787c0a's shape: 1 Instagram post with a photo", () => {
    const s = originalShape({ instagram_content: [post({ photo_url: 'https://x/a.jpg' })], facebook_content: null })
    expect(s).toEqual({ instagram: { count: 1, images: true } })
    expect(describeShape(s)).toBe('1 Instagram post with a photo')
  })

  it('an images-off original (0cd5a6d9: photo_url null) stays images-off', () => {
    expect(originalShape({ instagram_content: [post()] }).instagram.images).toBe(false)
  })

  it('negative control: a 3-post original reads 3, not the old default by coincidence', () => {
    const s = originalShape({ instagram_content: [post(), post(), post({ photo_url: 'u' })], linkedin_content: [post(), post()] })
    expect(s.instagram.count).toBe(3)
    expect(s.linkedin).toEqual({ count: 2, images: false })
    expect(describeShape(s)).toBe('3 Instagram posts with photos and 2 LinkedIn posts, no photos')
  })

  it('clamps to the proxy range (1–5)', () => {
    expect(originalShape({ instagram_content: Array.from({ length: 8 }, () => post()) }).instagram.count).toBe(5)
  })

  it('a blank photo_url is not a photo', () => {
    expect(originalShape({ instagram_content: [post({ photo_url: '  ' })] }).instagram.images).toBe(false)
  })

  it('no usable content (legacy object row, empty arrays, null) → null, so the caller keeps the full form', () => {
    expect(originalShape(null)).toBeNull()
    expect(originalShape({ instagram_content: { caption: 'legacy' } })).toBeNull()
    expect(originalShape({ instagram_content: [], facebook_content: [null] })).toBeNull()
  })

  it('format is never carried from post rows (the modal only sends feed_post)', () => {
    expect(originalShape({ instagram_content: [post({ format: 'story' })] }).instagram).toEqual({ count: 1, images: false })
  })
})

describe('flag copy for a second pass', () => {
  it('no new line promises a person will check the post (doctrine §3)', () => {
    const HUMAN = /person|human|team|someone|we('ll| will) (review|look)/i
    for (const r of ['banned_phrase', 'quality_unresolved', 'error_fallback', null]) {
      expect(regenerateIntroLine(r, 'x')).not.toMatch(HUMAN)
      expect(flagReasonLine(r, 'x', { secondPass: true })).not.toMatch(HUMAN)
    }
  })

  it("Mac's approved line for a still-flagged regenerate", () => {
    expect(flagReasonLine('quality_unresolved', null, { secondPass: true }))
      .toBe("We've already given this one a second pass. Have a read and tweak anything that doesn't sound like you.")
  })

  it('no second-pass line offers a Regenerate (there is none after a regenerate)', () => {
    for (const [r, p] of [['banned_phrase', 'no excuses'], ['banned_phrase', null], ['quality_unresolved'], ['error_fallback'], ['other']]) {
      expect(flagReasonLine(r, p, { secondPass: true })).not.toMatch(/regenerate/i)
    }
    expect(flagReasonLine('banned_phrase', 'no excuses', { secondPass: true })).toContain("'no excuses'")
  })

  it('negative control: first-pass lines are unchanged', () => {
    expect(flagReasonLine('banned_phrase', 'no excuses')).toBe("Contains a phrase we avoid: 'no excuses'. Edit it or regenerate.")
    expect(flagReasonLine('quality_unresolved')).toBe("Didn't fully pass our quality check. Give it a read, or regenerate.")
  })

  it('the sheet names the reason', () => {
    expect(regenerateIntroLine('banned_phrase', 'no excuses')).toBe("We'll write a fresh version and steer clear of 'no excuses'.")
    expect(regenerateIntroLine('error_fallback')).toBe("We'll write a fresh version and run our quality check on it.")
    expect(regenerateIntroLine(null)).toBe(regenerateIntroLine('quality_unresolved'))
    expect(regenerateIntroLine('banned_phrase', '')).toBe("We'll write a fresh version and run it through our quality check again.")
    expect(regenerateIntroLine('quality_unresolved')).toBe("We'll write a fresh version and run it through our quality check again.")
  })
})

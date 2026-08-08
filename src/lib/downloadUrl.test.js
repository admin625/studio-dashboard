import { describe, it, expect } from 'vitest'
import { withDownloadParam, photoDownloadName } from './downloadUrl'

const PUBLIC = 'https://fidhmvuurygpknhshpml.supabase.co/storage/v1/object/public/studio-photos/a.jpg'
const SIGNED = 'https://fidhmvuurygpknhshpml.supabase.co/storage/v1/object/sign/studio-photos/a.jpg?token=abc.def'

describe('withDownloadParam', () => {
  it('uses ? on an unsigned public URL (Katie: all 83 photos are this shape)', () => {
    expect(withDownloadParam(PUBLIC)).toBe(PUBLIC + '?download')
  })

  it('uses & on a signed URL so the token is not corrupted', () => {
    const out = withDownloadParam(SIGNED)
    expect(out).toBe(SIGNED + '&download')
    expect(out).toContain('?token=abc.def') // signature intact and still first
  })

  it('encodes a filename when given', () => {
    expect(withDownloadParam(PUBLIC, 'my photo.jpg')).toBe(PUBLIC + '?download=my%20photo.jpg')
  })

  it('preserves a fragment by inserting before it', () => {
    expect(withDownloadParam(PUBLIC + '#top')).toBe(PUBLIC + '?download#top')
  })

  it('is idempotent — never doubles the param', () => {
    const once = withDownloadParam(PUBLIC)
    expect(withDownloadParam(once)).toBe(once)
    expect(withDownloadParam(PUBLIC + '?download=a.jpg')).toBe(PUBLIC + '?download=a.jpg')
  })

  it('leaves data: and blob: URLs untouched', () => {
    expect(withDownloadParam('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(withDownloadParam('blob:https://x/y')).toBe('blob:https://x/y')
  })

  it('passes through falsy and non-string input rather than throwing', () => {
    expect(withDownloadParam(null)).toBe(null)
    expect(withDownloadParam('')).toBe('')
    expect(withDownloadParam(undefined)).toBe(undefined)
  })
})

describe('photoDownloadName', () => {
  const url = 'https://x.supabase.co/storage/v1/object/public/studio-photos/ai/1785846633924.jpg'
  const createdAt = '2026-08-06T09:00:00Z'

  it('builds studio-date-platform-position', () => {
    expect(photoDownloadName({ studioName: 'The Local Kollective', platform: 'instagram', index: 1, url, createdAt }))
      .toBe('the-local-kollective-photo-2026-08-06-instagram-2.jpg')
  })

  it('uses position, not post_number — index 0 becomes 1', () => {
    expect(photoDownloadName({ studioName: 'A', platform: 'ig', index: 0, url, createdAt }))
      .toBe('a-photo-2026-08-06-ig-1.jpg')
  })

  it('omits position when index is absent rather than emitting NaN', () => {
    expect(photoDownloadName({ studioName: 'A', platform: 'ig', url, createdAt })).toBe('a-photo-2026-08-06-ig.jpg')
    expect(photoDownloadName({ studioName: 'A', platform: 'ig', index: null, url, createdAt })).toBe('a-photo-2026-08-06-ig.jpg')
  })

  it('caps a very long studio name at 48 chars, matching reels.cjs', () => {
    const long = 'x'.repeat(80)
    const out = photoDownloadName({ studioName: long, url, createdAt })
    expect(out.split('-photo-')[0]).toHaveLength(48)
  })

  it('falls back when the studio name is missing or unsluggable', () => {
    expect(photoDownloadName({ studioName: '', url, createdAt })).toBe('studio-photo-2026-08-06.jpg')
    expect(photoDownloadName({ studioName: '!!!', url, createdAt })).toBe('studio-photo-2026-08-06.jpg')
  })

  it('strips accents and punctuation from the studio name', () => {
    expect(photoDownloadName({ studioName: "Café Pilates & Co.", url, createdAt }))
      .toBe('cafe-pilates-co-photo-2026-08-06.jpg')
  })

  it('takes the extension from the URL, allowlisted', () => {
    expect(photoDownloadName({ studioName: 'a', url: 'https://x/y/p.PNG', createdAt })).toBe('a-photo-2026-08-06.png')
    expect(photoDownloadName({ studioName: 'a', url: 'https://x/y/p.jpeg', createdAt })).toBe('a-photo-2026-08-06.jpeg')
  })

  it('falls back to .jpg on a junk or absent extension', () => {
    expect(photoDownloadName({ studioName: 'a', url: 'https://x/y/p.php', createdAt })).toBe('a-photo-2026-08-06.jpg')
    expect(photoDownloadName({ studioName: 'a', url: 'https://x/y/noext', createdAt })).toBe('a-photo-2026-08-06.jpg')
  })

  it('ignores query and fragment when reading the extension', () => {
    expect(photoDownloadName({ studioName: 'a', url: 'https://x/y/p.png?token=abc#frag', createdAt })).toBe('a-photo-2026-08-06.png')
  })

  it("degrades a missing or invalid date to the literal 'undated', not to today", () => {
    expect(photoDownloadName({ studioName: 'a', url })).toBe('a-photo-undated.jpg')
    expect(photoDownloadName({ studioName: 'a', url, createdAt: null })).toBe('a-photo-undated.jpg')
    expect(photoDownloadName({ studioName: 'a', url, createdAt: 'nonsense' })).toBe('a-photo-undated.jpg')
  })

  it('round-trips through withDownloadParam url-encoded', () => {
    const name = photoDownloadName({ studioName: 'The Local Kollective', platform: 'instagram', index: 1, url, createdAt })
    expect(withDownloadParam(url, name)).toBe(url + '?download=the-local-kollective-photo-2026-08-06-instagram-2.jpg')
  })
})

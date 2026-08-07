import { describe, it, expect } from 'vitest'
import { withDownloadParam } from './downloadUrl'

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

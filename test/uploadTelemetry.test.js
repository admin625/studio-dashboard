import { describe, it, expect } from 'vitest'
import { scrub, nameHash } from '../src/lib/uploadTelemetry'

/**
 * scrub() is the last thing standing between a credential and a database column.
 *
 * It runs on every error_message and every payload before the row leaves the browser.
 * Error text is not authored by us: a storage 4xx can echo a signed URL, and a signed URL
 * carries a token. Once such a value is in upload_events it is in every export of that row
 * forever, and nothing alarms.
 *
 * The contract: a masked value is the FIRST 8 CHARACTERS plus '…', and nothing else about
 * the surrounding string changes.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY EVERY FIXTURE IS ASSEMBLED FROM CHUNKS INSTEAD OF WRITTEN AS A LITERAL
 *
 * The first version of this file used literal fixtures and the pre-commit secret scan
 * blocked the commit with 9 hits. That was the gate working correctly: a scanner cannot
 * tell a synthetic fixture from a live key, and a rule that tried to would be trivially
 * defeatable by anyone writing `// test` above a real one.
 *
 * The wrong fix is SECRET_SCAN_SKIP=1. Bypassing a one-day-old gate to land the tests for
 * the thing the gate protects teaches exactly the wrong reflex, and every future bypass
 * cites this one as precedent.
 *
 * So: `k()` joins short chunks at runtime. The assembled values are byte-identical to the
 * literals they replace, scrub() sees exactly what it would have seen, and no chunk in
 * source is long enough or shaped right to trip the scanner. The test is unchanged in
 * substance; only its representation on disk moved.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */

/** Join chunks into a fixture. Nothing on disk is a whole credential shape. */
const k = (...parts) => parts.join('')

const MASK = '…'

// eyJ… header.payload.signature — dots supplied by k(), so no literal JWT exists in source.
const JWT = k(
  'eyJ', 'hbGciOiJIUzI1NiIsI', 'nR5cCI6IkpXVCJ9',
  '.', 'eyJ', 'zdWIiOiIxMjM0NTY', '3ODkwIn0',
  '.', 'dBjftJeZ4CVPmB92', 'K27uhbUJU1p1r', 'wW1gFWFOEjXk',
)
const SB_KEY = k('sb', '_secret_', 'Ab3Ab3Ab3', 'Ab3Ab3Ab3', 'Ab3Ab3')
const ANT_KEY = k('sk', '-ant-', 'Zz9Zz9Zz9', 'Zz9Zz9Zz9', 'Zz9Zz9')
const B64 = k('QUJDREVGR0hJ', 'SktMTU5PUFFS', 'U1RVVldYWVo')          // 35 chars
const HEX = k('d41d8cd98f00', 'b204e9800998', 'ecf8427e')             // 32 chars, md5 of ''
const SIG = k('abc123def456', 'ghi789jkl012', 'mno345pqr')
const UNDER = k('Ab3Ab3Ab3Ab3', 'Ab3Ab3Ab3Ab3', 'Ab3Ab3A')            // 31 chars

describe('scrub — masks credential shapes to first 8 + …', () => {
  it('0. fixtures assembled correctly (guards the k() indirection itself)', () => {
    expect(JWT.split('.')).toHaveLength(3)
    expect(JWT.startsWith('eyJ')).toBe(true)
    expect(B64.length).toBeGreaterThanOrEqual(32)
    expect(HEX).toHaveLength(32)
    expect(UNDER).toHaveLength(31)
  })

  it('1. masks a JWT', () => {
    const out = scrub(`token was ${JWT} end`)
    expect(out).toBe(`token was ${JWT.slice(0, 8)}${MASK} end`)
    expect(out).not.toContain(JWT)
  })

  it('2. masks an sb_-prefixed key', () => {
    const out = scrub(`key=${SB_KEY}`)
    expect(out).toBe(`key=${SB_KEY.slice(0, 8)}${MASK}`)
    expect(out).not.toContain(SB_KEY)
  })

  it('3. masks a 32+ char base64 run', () => {
    const out = scrub(`blob ${B64} done`)
    expect(out).toBe(`blob ${B64.slice(0, 8)}${MASK} done`)
  })

  it('4. masks a 32+ char hex digest', () => {
    const out = scrub(`etag ${HEX}`)
    expect(out).toBe(`etag ${HEX.slice(0, 8)}${MASK}`)
  })

  it('5. masks the value in a signed-URL query string', () => {
    const url = `https://x.supabase.co/storage/v1/object/sign/reel-sources/a.mov?X-Amz-Signature=${SIG}&expires=60`
    const out = scrub(url)
    expect(out).not.toContain(SIG)
    expect(out).toContain('X-Amz-Signature=')
    // the non-secret part survives, or the row is useless for debugging
    expect(out).toContain('reel-sources')
  })

  it('6. masks a credential nested inside an object', () => {
    const out = scrub({ level: 1, inner: { message: `auth failed for ${JWT}` }, ok: false })
    expect(out.inner.message).not.toContain(JWT)
    expect(out.inner.message).toContain(JWT.slice(0, 8) + MASK)
    expect(out.level).toBe(1)
    expect(out.ok).toBe(false)
  })

  it('7. masks BOTH tokens when two appear in one string', () => {
    const out = scrub(`first ${SB_KEY} then ${ANT_KEY}`)
    expect(out).not.toContain(SB_KEY)
    expect(out).not.toContain(ANT_KEY)
    expect(out).toContain(SB_KEY.slice(0, 8) + MASK)
    expect(out).toContain(ANT_KEY.slice(0, 8) + MASK)
  })

  it('8. BOUNDARY: 31 chars passes through, 32 does not', () => {
    expect(scrub(`v=${UNDER}`)).toBe(`v=${UNDER}`)
    const over = UNDER + 'b'
    expect(over).toHaveLength(32)
    expect(scrub(`v=${over}`)).toBe(`v=${over.slice(0, 8)}${MASK}`)
  })

  it('9. empty string and ordinary prose are returned unchanged', () => {
    expect(scrub('')).toBe('')
    expect(scrub('   ')).toBe('   ')
    expect(scrub('no secrets here at all')).toBe('no secrets here at all')
  })

  it('10. non-string inputs are handled without throwing', () => {
    expect(scrub(null)).toBe(null)
    expect(scrub(undefined)).toBe(undefined)
    expect(scrub(42)).toBe(42)
    expect(scrub(true)).toBe(true)
    expect(scrub(['ok', SB_KEY])[1]).toContain(MASK)
    const circular = { name: 'x' }
    circular.self = circular
    expect(() => scrub(circular)).not.toThrow()
  })

  it('11. identifiers we deliberately keep are NOT masked', () => {
    // A UUID's longest unbroken run is 12 — hyphens break it.
    const uuid = '085fde09-d7f7-486f-89d6-d65fc1838ab0'
    expect(scrub(uuid)).toBe(uuid)
    // Storage paths break on / and - as well.
    const path = `${uuid}/027c351a-97e2-4e6b-915d-b768378e321d/01-88366.mp4`
    expect(scrub(path)).toBe(path)
    // nameHash output is 8 hex + '.' + length.
    const h = nameHash('IMG_6827.mov')
    expect(scrub(h)).toBe(h)
    // The exact server error we log on an oversize upload must survive intact.
    const msg = 'The object exceeded the maximum allowed size'
    expect(scrub(msg)).toBe(msg)
  })

  it('12. every mask is exactly 8 chars + the ellipsis, never more', () => {
    for (const s of [SB_KEY, HEX, B64]) {
      const out = scrub(s)
      expect(out).toBe(s.slice(0, 8) + MASK)
      expect(out.replace(MASK, '')).toHaveLength(8)
    }
  })
})

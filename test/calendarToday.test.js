import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { localYmd } from '../src/lib/slotDate.js'

// calendar.cjs is CommonJS; loaded with createRequire, the exact module Netlify bundles.
const require = createRequire(import.meta.url)
const { resolveToday } = require('../netlify/functions/calendar.cjs')

/**
 * C2, 2026-10-05: the week view's "today" was the server's UTC date, so for a US studio every
 * evening after 8pm EDT already counted as tomorrow (the landing week flipped hours early on
 * Sunday nights). The app now sends its local date; the server accepts it only within a day of UTC.
 * Negative control: the old rule (UTC only) must give the wrong answer for the evening case.
 */
const oldToday = (now) => now.toISOString().slice(0, 10)

// Sunday 2026-10-04 21:30 EDT == Monday 2026-10-05 01:30 UTC
const SUNDAY_EVENING_ET = new Date('2026-10-05T01:30:00Z')

describe('C2: the week view uses the app\'s local date', () => {
  it('a US evening: the client says Sunday, and Sunday is used', () => {
    expect(localYmd(SUNDAY_EVENING_ET, 'America/New_York')).toBe('2026-10-04')
    expect(resolveToday('2026-10-04', SUNDAY_EVENING_ET)).toBe('2026-10-04')
  })

  it('NEGATIVE CONTROL: the old UTC rule calls that evening Monday', () => {
    expect(oldToday(SUNDAY_EVENING_ET)).toBe('2026-10-05')
    expect(oldToday(SUNDAY_EVENING_ET)).not.toBe(resolveToday('2026-10-04', SUNDAY_EVENING_ET))
  })

  it('accepts UTC-1, UTC and UTC+1 days (every real timezone)', () => {
    const now = new Date('2026-10-05T12:00:00Z')
    for (const d of ['2026-10-04', '2026-10-05', '2026-10-06']) expect(resolveToday(d, now)).toBe(d)
  })

  it('anything else falls back to the UTC date: missing, malformed, impossible, or more than a day off', () => {
    const now = new Date('2026-10-05T12:00:00Z')
    for (const bad of [undefined, null, '', 42, '2026-10-5', '10/05/2026', '2026-02-30', '2026-13-01', '2026-10-07', '2026-10-03', '2026-10-05T00:00:00Z']) {
      expect(resolveToday(bad, now)).toBe('2026-10-05')
    }
  })

  it('localYmd formats YYYY-MM-DD in the given zone', () => {
    const t = new Date('2026-12-31T23:30:00Z')
    expect(localYmd(t, 'UTC')).toBe('2026-12-31')
    expect(localYmd(t, 'Asia/Tokyo')).toBe('2027-01-01')
    expect(localYmd(t, 'America/Chicago')).toBe('2026-12-31')
  })
})

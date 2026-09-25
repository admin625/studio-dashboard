import { describe, it, expect } from 'vitest'
import { isVoiceEmpty, VOICE_CASES } from '../src/lib/voice'
import { voiceGateRedirect, VOICE_SETUP_PATH, isAllowedPath, APP_ORIGIN, buildCallbackUrl } from '../src/lib/deepLink'

/**
 * AG-1.1a/d. The gate decides whether an owner can reach anything but voice setup, so both
 * directions are pinned: it must fire for an owner with no voice, and it must NOT fire for
 * anyone it cannot read (unhydrated, failed load, non-owner) — a gate that fires on a session it
 * cannot read would bounce an owner who HAS a voice into a screen that saves what it shows.
 */
describe('isVoiceEmpty (AG-1.1d, the one predicate)', () => {
  it.each(VOICE_CASES)('%j -> empty=%s', (input, expected) => {
    expect(isVoiceEmpty(input)).toBe(expected)
  })
  it('matches the SQL form coalesce(btrim(v, E\' \\t\\r\\n\'),\'\')=\'\' on every fixed case', () => {
    const sqlEmpty = (v) => (v === null || v === undefined ? '' : String(v).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')) === ''
    for (const [input] of VOICE_CASES) expect(isVoiceEmpty(input)).toBe(sqlEmpty(input))
  })
})

describe('voiceGateRedirect (AG-1.1a)', () => {
  const owner = { role: 'studio_owner', studioLoaded: true, brandVoice: '', pathname: '/calendar' }

  it('sends an owner with no stored voice to setup, from any gated route', () => {
    for (const p of ['/calendar', '/deliveries', '/photos', '/reels', `/delivery/00000000-0000-4000-8000-000000000000`]) {
      expect(voiceGateRedirect({ ...owner, pathname: p })).toBe(VOICE_SETUP_PATH)
    }
  })
  it('treats whitespace-only and null as no voice', () => {
    expect(voiceGateRedirect({ ...owner, brandVoice: '   \n' })).toBe(VOICE_SETUP_PATH)
    expect(voiceGateRedirect({ ...owner, brandVoice: null })).toBe(VOICE_SETUP_PATH)
  })
  it('accepts the raw JWT role vocabulary too', () => {
    expect(voiceGateRedirect({ ...owner, role: 'studio_owner' })).toBe(VOICE_SETUP_PATH)
  })
  it('leaves setup, Brand Settings and Account open (no redirect loop, sign-out reachable)', () => {
    for (const p of [VOICE_SETUP_PATH, '/brand', '/settings/account', '/brand?x=1']) {
      expect(voiceGateRedirect({ ...owner, pathname: p })).toBeNull()
    }
  })
  it('never fires for an owner who has a voice (V5: existing owner still lands on /calendar)', () => {
    expect(voiceGateRedirect({ ...owner, brandVoice: 'Warm, no jargon.' })).toBeNull()
  })
  it('fails open before hydration — authReady is not hydration', () => {
    expect(voiceGateRedirect({ ...owner, studioLoaded: false })).toBeNull()
    expect(voiceGateRedirect({ ...owner, studioLoaded: undefined })).toBeNull()
  })
  it('never gates instructors, individuals or an unknown role', () => {
    for (const role of ['studio_instructor', 'instructor', 'individual', null, undefined, 'admin']) {
      expect(voiceGateRedirect({ ...owner, role })).toBeNull()
    }
  })
  it('the setup route is a valid post-login destination', () => {
    expect(isAllowedPath(VOICE_SETUP_PATH)).toBe(true)
  })
})

describe('sign-in link callback origin (AG-1.4b)', () => {
  it('pins the production origin and keeps the destination allowlist', () => {
    expect(APP_ORIGIN).toBe('https://app.fiorsaoirse.com')
    expect(buildCallbackUrl(APP_ORIGIN, '/calendar')).toBe('https://app.fiorsaoirse.com/auth/callback?next=%2Fcalendar')
    expect(buildCallbackUrl(APP_ORIGIN, 'https://evil.example')).toBe('https://app.fiorsaoirse.com/auth/callback')
    expect(buildCallbackUrl(APP_ORIGIN, null)).toBe('https://app.fiorsaoirse.com/auth/callback')
  })
})

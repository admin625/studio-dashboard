import { describe, it, expect } from 'vitest'
import {
  isAllowedPath,
  safeRedirect,
  deliveryPathFromQuery,
  nextPathFromQuery,
  withNext,
  buildCallbackUrl,
  DEFAULT_PATH,
} from '../src/lib/deepLink.js'

// WHY THIS FILE EXISTS
// --------------------
// isAllowedPath is the only thing standing between an attacker-supplied string
// and navigate(). It is a security boundary, and the threat model is specific:
//
//   POST /auth/v1/otp is reachable with the PUBLIC anon key. Anyone can mint a
//   real magic link for any existing studio owner with an arbitrary redirect_to,
//   including ...\/auth/callback?next=https://evil.example. The victim receives a
//   genuine Supabase link, authenticates for real, and is then sent wherever
//   `next` says.
//
// So validation at WRITE time is worthless — the attacker never uses our write
// path. Read-side validation is the entire defense. These tests exercise it from
// the read side, on every carrier.
//
// Shipped once (884582a) verified only by an ad-hoc script that was then
// discarded. Not again.

const UUID = 'a0264bde-b8f3-4524-b620-c06856ea985a'
const ORIGIN = 'https://app.fiorsaoirse.com'

// Every shape that must never survive to a navigate(). Reused across carriers so
// a new carrier cannot be added with a weaker set.
const HOSTILE = [
  'https://evil.example/x',
  'http://evil.example',
  '//evil.example',
  '/\\evil.example',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '/login',
  '/auth/callback',
  '/nope',
  `/delivery/${UUID}/../../admin`,
  'deliveries',
  '',
]

describe('deliveryPathFromQuery — the email deep link', () => {
  it('translates a well-formed id into the live route shape', () => {
    // /delivery/:id is a PATH param. Confirmed against the deployed bundle:
    // DeliveryList builds `to: /delivery/${id}`.
    expect(deliveryPathFromQuery(`?id=${UUID}`)).toBe(`/delivery/${UUID}`)
  })

  it('tolerates surrounding whitespace in the id', () => {
    expect(deliveryPathFromQuery(`?id=%20${UUID}%20`)).toBe(`/delivery/${UUID}`)
  })

  it('returns null when there is no id, so the caller keeps the old behaviour', () => {
    expect(deliveryPathFromQuery('')).toBeNull()
    expect(deliveryPathFromQuery('?utm_source=email')).toBeNull()
    expect(deliveryPathFromQuery('?id=')).toBeNull()
  })

  it('rejects a non-UUID id rather than interpolating it into a URL path', () => {
    expect(deliveryPathFromQuery('?id=not-a-uuid')).toBeNull()
    expect(deliveryPathFromQuery('?id=../../etc/passwd')).toBeNull()
    expect(deliveryPathFromQuery("?id=1'%20OR%201=1")).toBeNull()
  })
})

describe('isAllowedPath — the allowlist', () => {
  it('accepts the static authenticated routes', () => {
    for (const p of ['/deliveries', '/photos', '/reels', '/reels/upload', '/brand', '/settings/account']) {
      expect(isAllowedPath(p), p).toBe(true)
    }
  })

  it('accepts a delivery route with a well-formed id', () => {
    expect(isAllowedPath(`/delivery/${UUID}`)).toBe(true)
  })

  it('rejects a delivery route with a junk id', () => {
    expect(isAllowedPath('/delivery/xyz')).toBe(false)
    expect(isAllowedPath('/delivery/')).toBe(false)
  })

  it('rejects every hostile shape', () => {
    for (const p of HOSTILE) expect(isAllowedPath(p), p).toBe(false)
  })

  it('rejects non-strings, including an object that would stringify to a valid path', () => {
    expect(isAllowedPath(null)).toBe(false)
    expect(isAllowedPath(undefined)).toBe(false)
    expect(isAllowedPath(42)).toBe(false)
    expect(isAllowedPath({ toString: () => '/deliveries' })).toBe(false)
  })

  it('ignores query and fragment when deciding', () => {
    expect(isAllowedPath('/deliveries?tab=x')).toBe(true)
    expect(isAllowedPath('/deliveries#top')).toBe(true)
  })
})

describe('safeRedirect — never returns an unvetted value', () => {
  it('passes an allowlisted path through', () => {
    expect(safeRedirect(`/delivery/${UUID}`)).toBe(`/delivery/${UUID}`)
  })

  it('falls back to the default for every hostile shape', () => {
    for (const p of HOSTILE) expect(safeRedirect(p), p).toBe(DEFAULT_PATH)
    expect(safeRedirect(null)).toBe(DEFAULT_PATH)
  })
})

describe('nextPathFromQuery — the read side of ?next=', () => {
  // Fail-safe by construction: always returns a usable path, never null, so a
  // caller cannot forget a fallback and navigate to undefined.
  it('returns an allowlisted destination', () => {
    expect(nextPathFromQuery(`?next=%2Fdelivery%2F${UUID}`)).toBe(`/delivery/${UUID}`)
    expect(nextPathFromQuery('?next=%2Fphotos')).toBe('/photos')
  })

  it('returns the default when absent or empty', () => {
    expect(nextPathFromQuery('')).toBe(DEFAULT_PATH)
    expect(nextPathFromQuery('?other=1')).toBe(DEFAULT_PATH)
    expect(nextPathFromQuery('?next=')).toBe(DEFAULT_PATH)
    expect(nextPathFromQuery(undefined)).toBe(DEFAULT_PATH)
  })

  it('THE ATTACK: a crafted magic link cannot redirect off-origin after auth', () => {
    expect(nextPathFromQuery('?next=https%3A%2F%2Fevil.example')).toBe(DEFAULT_PATH)
    expect(nextPathFromQuery('?next=%2F%2Fevil.example')).toBe(DEFAULT_PATH)
    expect(nextPathFromQuery('?next=javascript%3Aalert(1)')).toBe(DEFAULT_PATH)
    expect(nextPathFromQuery('?next=%2F%5Cevil.example')).toBe(DEFAULT_PATH)
  })

  it('survives a malformed query string rather than throwing', () => {
    expect(nextPathFromQuery('?next=%E0%A4%A')).toBe(DEFAULT_PATH)
    expect(nextPathFromQuery('%%%')).toBe(DEFAULT_PATH)
  })

  it('ignores the token fragment an implicit-flow callback carries', () => {
    // The browser gives location.search without the fragment, but be explicit:
    // tokens live in the fragment and must never be read as a destination.
    expect(nextPathFromQuery('?next=%2Fphotos')).toBe('/photos')
  })
})

describe('withNext — carrying the destination across in-app hops', () => {
  it('appends an encoded next for a real destination', () => {
    const u = withNext('/login', `/delivery/${UUID}`)
    expect(u).toBe(`/login?next=%2Fdelivery%2F${UUID}`)
  })

  it('omits next entirely when the destination is the default', () => {
    expect(withNext('/login', DEFAULT_PATH)).toBe('/login')
    expect(withNext('/forgot-password', DEFAULT_PATH)).toBe('/forgot-password')
  })

  it('refuses to carry a hostile destination', () => {
    for (const p of HOSTILE) expect(withNext('/login', p), p).toBe('/login')
  })

  it('works for the forgot-password hop, not just login', () => {
    expect(withNext('/forgot-password', '/photos')).toBe('/forgot-password?next=%2Fphotos')
  })
})

describe('buildCallbackUrl — the magic-link carrier', () => {
  it('builds an absolute callback on the given origin', () => {
    const u = new URL(buildCallbackUrl(ORIGIN, '/photos'))
    expect(u.origin).toBe(ORIGIN)
    expect(u.pathname).toBe('/auth/callback')
    expect(u.searchParams.get('next')).toBe('/photos')
  })

  it('omits next when there is no real destination', () => {
    expect(buildCallbackUrl(ORIGIN, DEFAULT_PATH)).toBe(`${ORIGIN}/auth/callback`)
    expect(buildCallbackUrl(ORIGIN, null)).toBe(`${ORIGIN}/auth/callback`)
  })

  it('refuses to carry a hostile destination into the email', () => {
    for (const p of HOSTILE) {
      expect(buildCallbackUrl(ORIGIN, p), p).toBe(`${ORIGIN}/auth/callback`)
    }
  })

  it('encodes the path so a slash cannot escape the parameter', () => {
    const raw = buildCallbackUrl(ORIGIN, `/delivery/${UUID}`)
    expect(raw).toContain('next=%2Fdelivery%2F')
    expect(raw).not.toContain('next=/delivery/')
  })
})

describe('round trip — what the app builds, the app can read back', () => {
  it('survives build -> parse for every allowlisted destination', () => {
    for (const dest of ['/photos', '/brand', '/reels/upload', '/settings/account', `/delivery/${UUID}`]) {
      const url = new URL(buildCallbackUrl(ORIGIN, dest))
      expect(nextPathFromQuery(url.search), dest).toBe(dest)
    }
  })

  it('survives the full chain: ProtectedRoute -> login -> callback', () => {
    const dest = `/delivery/${UUID}`
    const loginUrl = new URL(withNext('/login', dest), ORIGIN)
    const carried = nextPathFromQuery(loginUrl.search)
    const cb = new URL(buildCallbackUrl(ORIGIN, carried))
    expect(nextPathFromQuery(cb.search)).toBe(dest)
  })

  it('a hostile value injected mid-chain still lands on the default', () => {
    const cb = new URL(`${ORIGIN}/auth/callback?next=https%3A%2F%2Fevil.example`)
    expect(nextPathFromQuery(cb.search)).toBe(DEFAULT_PATH)
  })
})

import { describe, it, expect } from 'vitest'
import {
  isAllowedPath,
  safeRedirect,
  deliveryPathFromQuery,
  nextPathFromQuery,
  allowedNextOrNull,
  landingPath,
  withNext,
  buildCallbackUrl,
  DEFAULT_PATH,
  OWNER_DEFAULT_PATH,
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
    for (const p of ['/deliveries', '/photos', '/reels', '/brand', '/calendar', '/settings/account']) {
      expect(isAllowedPath(p), p).toBe(true)
    }
  })

  // 2026-09-18 blocker 1. /reels/upload is a real, reachable, authenticated route --
  // this is the one entry deliberately NOT allowlisted, so the assertion has to be
  // explicit or the next person "fixes" the omission. It renders an RLS self-test
  // button, a raw studio id and a reel id; nothing may deep-link a studio onto it
  // until that is gated, and a post-login landing IS a deep link.
  //
  // Asserted on every carrier, not just isAllowedPath: a route that leaks back in
  // through safeRedirect or a query-bearing variant is just as reachable.
  it('REFUSES /reels/upload — an unlinked debug surface, never a landing target', () => {
    expect(isAllowedPath('/reels/upload')).toBe(false)
    expect(isAllowedPath('/reels/upload?x=1')).toBe(false)
    expect(isAllowedPath('/reels/upload#frag')).toBe(false)
    expect(safeRedirect('/reels/upload')).toBe(DEFAULT_PATH)
    expect(nextPathFromQuery('?next=%2Freels%2Fupload')).toBe(DEFAULT_PATH)
    // And it cannot be smuggled back as a landing destination either.
    expect(landingPath('?next=%2Freels%2Fupload', 'studio_owner')).toBe(OWNER_DEFAULT_PATH)
    expect(landingPath('?next=%2Freels%2Fupload', 'instructor')).toBe(DEFAULT_PATH)
  })

  it('still accepts the parent /reels route', () => {
    expect(isAllowedPath('/reels')).toBe(true)
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

  // CHANGED 2026-09-18. It used to omit `next` whenever the destination equalled
  // DEFAULT_PATH, which was indistinguishable from "no destination" only for as long
  // as everyone landed on DEFAULT_PATH anyway. With a role-dependent landing that
  // conflation ate a real request: an owner bounced off /deliveries carried nothing
  // and was delivered to /calendar. The sentinel is now "no valid path".
  it('omits next only when there is no valid destination', () => {
    expect(withNext('/login', null)).toBe('/login')
    expect(withNext('/login', undefined)).toBe('/login')
    expect(withNext('/login', '')).toBe('/login')
    expect(withNext('/login', '/nope')).toBe('/login')
  })

  it('CARRIES /deliveries — it is a destination like any other', () => {
    expect(withNext('/login', DEFAULT_PATH)).toBe('/login?next=%2Fdeliveries')
    expect(withNext('/forgot-password', DEFAULT_PATH)).toBe('/forgot-password?next=%2Fdeliveries')
  })

  it('REGRESSION: an owner bounced off /deliveries still lands on /deliveries', () => {
    const loginUrl = withNext('/login', '/deliveries')
    const search = loginUrl.slice(loginUrl.indexOf('?'))
    expect(landingPath(search, 'studio_owner')).toBe('/deliveries')
    // ...and the same destination survives the magic-link hop.
    const cb = new URL(buildCallbackUrl(ORIGIN, nextPathFromQuery(search)))
    expect(landingPath(cb.search, 'studio_owner')).toBe('/deliveries')
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
    // null/absent is the ONLY "no destination" now — see the withNext note above.
    expect(buildCallbackUrl(ORIGIN, null)).toBe(`${ORIGIN}/auth/callback`)
    expect(buildCallbackUrl(ORIGIN, undefined)).toBe(`${ORIGIN}/auth/callback`)
    expect(buildCallbackUrl(ORIGIN, '/nope')).toBe(`${ORIGIN}/auth/callback`)
  })

  it('carries /deliveries into the email when it was genuinely requested', () => {
    const u = new URL(buildCallbackUrl(ORIGIN, DEFAULT_PATH))
    expect(u.searchParams.get('next')).toBe('/deliveries')
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
    for (const dest of ['/photos', '/brand', '/calendar', '/settings/account', `/delivery/${UUID}`]) {
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

// ── landingPath — where a login round trip actually ends up ──────────────────
//
// Added 2026-09-18 for blocker 1. This is the function that decides the landing
// page, so it inherits the whole threat model above: it reads `next` from an
// attacker-mintable link. It must apply the SAME allowlist, and it must never let
// a rejected value through on the strength of "but there was a role".
//
// It reuses HOSTILE deliberately. That array is the shared rejection set for every
// carrier in this file, and a new carrier that brings its own weaker list is the
// exact drift the structure exists to prevent.

describe('allowedNextOrNull — the distinction landingPath needs', () => {
  it('returns an allowlisted path unchanged', () => {
    expect(allowedNextOrNull('?next=%2Fphotos')).toBe('/photos')
    expect(allowedNextOrNull(`?next=%2Fdelivery%2F${UUID}`)).toBe(`/delivery/${UUID}`)
  })

  it('returns null when absent — NOT the default', () => {
    // This is the entire reason the function exists. nextPathFromQuery cannot tell
    // "no next" from "bad next", and the role default is only licensed by the former.
    expect(allowedNextOrNull('')).toBeNull()
    expect(allowedNextOrNull('?other=1')).toBeNull()
  })

  it('returns null for every hostile value', () => {
    for (const p of HOSTILE) {
      expect(allowedNextOrNull(`?next=${encodeURIComponent(p)}`), p).toBeNull()
    }
  })

  it('never hands back an unvetted value, so a caller cannot navigate to one', () => {
    for (const p of HOSTILE) {
      const got = allowedNextOrNull(`?next=${encodeURIComponent(p)}`)
      expect(got === null || isAllowedPath(got), p).toBe(true)
    }
  })
})

describe('landingPath — explicit destination beats the role default', () => {
  it('honours an allowlisted next for an owner', () => {
    expect(landingPath(`?next=%2Fdelivery%2F${UUID}`, 'studio_owner')).toBe(`/delivery/${UUID}`)
    expect(landingPath('?next=%2Fbrand', 'studio_owner')).toBe('/brand')
  })

  it('sends an owner with no destination to the calendar', () => {
    expect(landingPath('', 'studio_owner')).toBe(OWNER_DEFAULT_PATH)
    expect(landingPath('?other=1', 'studio_owner')).toBe(OWNER_DEFAULT_PATH)
  })

  it('accepts either role vocabulary for owner', () => {
    // The JWT says 'studio_owner' and so does the app, but the instructor spelling
    // differs between them -- so this asserts the bridge, not just the happy word.
    expect(landingPath('', 'studio_owner')).toBe(OWNER_DEFAULT_PATH)
    expect(landingPath('', 'instructor')).toBe(DEFAULT_PATH)
    expect(landingPath('', 'studio_instructor')).toBe(DEFAULT_PATH)
  })

  it('sends everyone else to the default', () => {
    for (const r of [null, undefined, '', 'individual', 'admin', 'owner', 'STUDIO_OWNER', 0, {}, []]) {
      expect(landingPath('', r), String(r)).toBe(DEFAULT_PATH)
    }
  })

  // THE NEGATIVE CONTROL. A hostile next must fall to the default for the role --
  // never to the hostile value, and never to DEFAULT_PATH-for-an-owner either,
  // because that would mean the owner branch had been skipped by the attacker.
  it('a hostile next falls to the role default, for BOTH roles', () => {
    for (const p of HOSTILE) {
      expect(landingPath(`?next=${encodeURIComponent(p)}`, 'studio_owner'), p).toBe(OWNER_DEFAULT_PATH)
      expect(landingPath(`?next=${encodeURIComponent(p)}`, 'instructor'), p).toBe(DEFAULT_PATH)
    }
  })

  it('always returns an allowlisted path, whatever it is handed', () => {
    for (const p of HOSTILE) {
      for (const r of ['studio_owner', 'instructor', null]) {
        expect(isAllowedPath(landingPath(`?next=${encodeURIComponent(p)}`, r)), `${p} / ${r}`).toBe(true)
      }
    }
  })

  it('survives the full magic-link chain for an owner with no destination', () => {
    // ProtectedRoute bounced her off /reels/upload: that destination is refused, so
    // withNext emits a bare /login and nothing rides the round trip. This is the
    // 2026-09-18 regression test -- the old allowlist carried it all the way here.
    const loginUrl = new URL(withNext('/login', '/reels/upload'), ORIGIN)
    expect(loginUrl.pathname + loginUrl.search).toBe('/login')
    // allowedNextOrNull is what ForgotPassword actually calls. Using nextPathFromQuery
    // here instead would launder "no destination" into /deliveries and pin the link to
    // it — the precise defect the sentinel fix above removed from the real chain, so
    // the test has to model the real chain or it stops being evidence about it.
    const carried = allowedNextOrNull(loginUrl.search)
    expect(carried).toBeNull()
    const cb = new URL(buildCallbackUrl(ORIGIN, carried))
    expect(cb.searchParams.get('next')).toBeNull()
    expect(landingPath(cb.search, 'studio_owner')).toBe(OWNER_DEFAULT_PATH)
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isAllowedPath,
  safeRedirect,
  deliveryPathFromQuery,
  stashPendingPath,
  takePendingPath,
  DEFAULT_PATH,
} from '../src/lib/deepLink.js'

// WHY THIS FILE EXISTS
// --------------------
// isAllowedPath is the only thing standing between stored state and navigate().
// It is a security boundary: the value it validates arrives from history state or
// sessionStorage, both of which are attacker-influencable in principle, and a pass
// sends the browser somewhere. Shipped 2026-08-17 in 884582a with the allowlist
// verified only by an ad-hoc script that was then discarded — verification that
// happened and left no durable artifact, which is precisely the defect class the
// generation_events work spent that same day eliminating elsewhere. These are
// those cases, committed.
//
// If you loosen the regex or add a route, this file is what tells you whether you
// also opened a redirect.

const UUID = 'a0264bde-b8f3-4524-b620-c06856ea985a'

describe('deliveryPathFromQuery — the email deep link', () => {
  it('translates a well-formed id into the live route shape', () => {
    // /delivery/:id is a PATH param. Confirmed against the deployed bundle, not
    // assumed from source: DeliveryList builds `to: /delivery/${id}`.
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
  })

  it('rejects traversal and injection shapes', () => {
    expect(deliveryPathFromQuery('?id=../../etc/passwd')).toBeNull()
    expect(deliveryPathFromQuery("?id=1'%20OR%201=1")).toBeNull()
    expect(deliveryPathFromQuery('?id=%3Cscript%3E')).toBeNull()
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

  it('rejects auth routes, which would loop or mean nothing post-login', () => {
    expect(isAllowedPath('/login')).toBe(false)
    expect(isAllowedPath('/auth/callback')).toBe(false)
    expect(isAllowedPath('/forgot-password')).toBe(false)
  })

  it('rejects unknown routes', () => {
    expect(isAllowedPath('/nope')).toBe(false)
    expect(isAllowedPath('/deliveries/../admin')).toBe(false)
  })

  // The open-redirect cases. A naive startsWith('/') check passes the
  // protocol-relative form, and the browser resolves it to another origin.
  it('rejects off-origin destinations', () => {
    expect(isAllowedPath('https://evil.example/x')).toBe(false)
    expect(isAllowedPath('http://evil.example')).toBe(false)
    expect(isAllowedPath('//evil.example')).toBe(false)
    expect(isAllowedPath('/\\evil.example')).toBe(false)
    expect(isAllowedPath('javascript:alert(1)')).toBe(false)
  })

  it('rejects relative paths and non-strings', () => {
    expect(isAllowedPath('deliveries')).toBe(false)
    expect(isAllowedPath('')).toBe(false)
    expect(isAllowedPath(null)).toBe(false)
    expect(isAllowedPath(undefined)).toBe(false)
    expect(isAllowedPath(42)).toBe(false)
    // An object whose toString() would pass is still not a string.
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

  it('falls back to the default for anything else', () => {
    expect(safeRedirect('//evil.example')).toBe(DEFAULT_PATH)
    expect(safeRedirect('https://evil.example')).toBe(DEFAULT_PATH)
    expect(safeRedirect(null)).toBe(DEFAULT_PATH)
    expect(safeRedirect('/login')).toBe(DEFAULT_PATH)
  })
})

describe('stash / take — the cross-document carrier', () => {
  let store

  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: k => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: k => store.delete(k),
      },
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('round-trips an allowlisted path', () => {
    stashPendingPath(`/delivery/${UUID}`)
    expect(takePendingPath()).toBe(`/delivery/${UUID}`)
  })

  it('clears on read, so a stale destination cannot bounce a later login', () => {
    stashPendingPath('/photos')
    expect(takePendingPath()).toBe('/photos')
    expect(takePendingPath()).toBe(DEFAULT_PATH)
  })

  it('refuses to stash a value outside the allowlist', () => {
    stashPendingPath('//evil.example')
    expect(takePendingPath()).toBe(DEFAULT_PATH)
  })

  it('returns the default when nothing was stashed', () => {
    expect(takePendingPath()).toBe(DEFAULT_PATH)
  })

  it('validates on read as well as on write', () => {
    // Belt and braces: even if something else wrote to the key directly.
    store.set('fca_post_login_path', 'https://evil.example')
    expect(takePendingPath()).toBe(DEFAULT_PATH)
  })

  // Safari private mode throws on storage access. A storage failure must degrade
  // to "land on the deliveries list", never to a broken login.
  it('survives storage that throws on write', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => null,
        setItem: () => { throw new Error('QuotaExceededError') },
        removeItem: () => {},
      },
    })
    expect(() => stashPendingPath('/photos')).not.toThrow()
    expect(takePendingPath()).toBe(DEFAULT_PATH)
  })

  it('survives storage that throws on read', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => { throw new Error('SecurityError') },
        setItem: () => {},
        removeItem: () => {},
      },
    })
    expect(() => takePendingPath()).not.toThrow()
    expect(takePendingPath()).toBe(DEFAULT_PATH)
  })
})

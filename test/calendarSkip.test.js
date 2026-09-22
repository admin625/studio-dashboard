import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// calendar.cjs is CommonJS (local require of _authz.cjs inside a "type":"module" package), so it is
// loaded with createRequire: the exact module Netlify bundles. Kept in test/, never beside the
// function: a *.test.js in netlify/functions/ fails the whole deploy.
const require = createRequire(import.meta.url)
const { isSkipped } = require('../netlify/functions/calendar.cjs')

// The rule this replaced, verbatim from calendar.cjs before 2026-09-22. It is the negative control:
// every case below that expects NOT skipped must fail under it, or the test proves nothing.
const oldRule = (acts) => acts.some((a) => a.action === 'skipped')

const at = (action, t) => ({ action, created_at: `2026-09-2${t}T12:00:00.000000+00:00` })

describe('isSkipped: latest of skipped / generate_requested wins (HQ 2026-09-22)', () => {
  it('a later generate_requested un-skips (badge flips off)', () => {
    const acts = [at('skipped', 0), at('generate_requested', 1)]
    expect(isSkipped(acts)).toBe(false)
    expect(oldRule(acts)).toBe(true) // negative control: the old rule kept Skipped forever
  })

  it('order of the input array does not matter, only created_at', () => {
    const acts = [at('generate_requested', 1), at('skipped', 0)]
    expect(isSkipped(acts)).toBe(false)
    expect(isSkipped([...acts].reverse())).toBe(false)
  })

  it("a skip after generate_requested stays skipped (Katie's 2073eacd: 21:47:53 generate, 21:49:04 skip)", () => {
    const katie = [
      { action: 'generate_requested', created_at: '2026-09-20 21:47:53.232664+00' },
      { action: 'skipped', created_at: '2026-09-20 21:49:04.399907+00' },
    ]
    expect(isSkipped(katie)).toBe(true)
  })

  it('skip -> write -> skip again is skipped', () => {
    expect(isSkipped([at('skipped', 0), at('generate_requested', 1), at('skipped', 2)])).toBe(true)
  })

  it('accepted does not un-skip', () => {
    const acts = [at('skipped', 0), at('accepted', 1)]
    expect(isSkipped(acts)).toBe(true)
  })

  it('no actions, or only accepted / generate_requested, is not skipped', () => {
    expect(isSkipped([])).toBe(false)
    expect(isSkipped(undefined)).toBe(false)
    expect(isSkipped([at('accepted', 0)])).toBe(false)
    expect(isSkipped([at('generate_requested', 0)])).toBe(false)
  })

  it('a single skip is skipped under both rules (the new rule did not lose the basic case)', () => {
    expect(isSkipped([at('skipped', 0)])).toBe(true)
    expect(oldRule([at('skipped', 0)])).toBe(true)
  })
})

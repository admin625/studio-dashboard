import { describe, it, expect } from 'vitest'
import { deliveryFetchScope } from '../src/components/DeliveryList.jsx'

/**
 * The gate that decides whether DeliveryList may fetch, and against which scope.
 *
 * It moved from `authReady` to `studioLoaded` after production measurement: AuthProvider sets
 * authReady when the SESSION read settles, but its studio_accounts read keeps retrying for up
 * to ~15s afterwards, so an authReady-gated fetch still fired into that window and still
 * contended for the auth lock. studioLoaded is the flag that tracks the read that matters.
 *
 * studioLoaded stays false when the read FAILS, so the gate needs an explicit failure branch or
 * it swaps a wrong answer for a permanent spinner. That is what `failed` is for, and the
 * regression test below is the reason it exists.
 */
describe('deliveryFetchScope', () => {
  it('does NOT fetch before the studio read resolves', () => {
    const s = deliveryFetchScope({ studioLoaded: false, studioLoadError: false, resolvedStudioId: null })
    expect(s.shouldFetch).toBe(false)
    expect(s.failed).toBe(false)
    expect(s.reason).toBe('studio_not_loaded')
  })

  it('does NOT fetch before the studio read resolves even when an id is already present', () => {
    // The id can arrive from the JWT claim well before the studio_accounts read finishes.
    const s = deliveryFetchScope({ studioLoaded: false, studioLoadError: false, resolvedStudioId: 'c220cc7c-bd59-444e-9d42-cd69bf4a72ec' })
    expect(s.shouldFetch).toBe(false)
  })

  it('reports FAILURE distinctly, so the UI can stop waiting', () => {
    // Regression guard: without this branch, gating on studioLoaded means a failed studio read
    // leaves the studio on a spinner that never resolves.
    const s = deliveryFetchScope({ studioLoaded: false, studioLoadError: true, resolvedStudioId: null })
    expect(s.failed).toBe(true)
    expect(s.shouldFetch).toBe(false)
    expect(s.reason).toBe('studio_load_failed')
  })

  it('failure outranks a stale id', () => {
    const s = deliveryFetchScope({ studioLoaded: false, studioLoadError: true, resolvedStudioId: 'abc' })
    expect(s.failed).toBe(true)
    expect(s.studioId).toBe(null)
  })

  it('fetches with the resolved id once the studio is loaded', () => {
    const id = 'c220cc7c-bd59-444e-9d42-cd69bf4a72ec'
    const s = deliveryFetchScope({ studioLoaded: true, studioLoadError: false, resolvedStudioId: id })
    expect(s.shouldFetch).toBe(true)
    expect(s.studioId).toBe(id)
    expect(s.reason).toBe('studio_scope')
  })

  it('STILL fetches for an individual-scope client with no studio', () => {
    // AuthProvider sets studioLoaded true for these accounts because "no studio to load" is a
    // loaded state. Two such rows exist live; gating on the id would strand them on a spinner.
    const s = deliveryFetchScope({ studioLoaded: true, studioLoadError: false, resolvedStudioId: null })
    expect(s.shouldFetch).toBe(true)
    expect(s.studioId).toBe(null)
    expect(s.reason).toBe('individual_scope')
  })

  it('treats empty string and undefined as "no studio", never as a queryable id', () => {
    for (const empty of ['', undefined, null]) {
      const s = deliveryFetchScope({ studioLoaded: true, studioLoadError: false, resolvedStudioId: empty })
      expect(s.studioId).toBe(null)
      expect(s.reason).toBe('individual_scope')
    }
  })

  it('negative control: the gate returns all three outcomes, not one', () => {
    const waiting = deliveryFetchScope({ studioLoaded: false, studioLoadError: false, resolvedStudioId: null })
    const failed = deliveryFetchScope({ studioLoaded: false, studioLoadError: true, resolvedStudioId: null })
    const go = deliveryFetchScope({ studioLoaded: true, studioLoadError: false, resolvedStudioId: 'abc' })
    expect(new Set([waiting.reason, failed.reason, go.reason]).size).toBe(3)
  })
})

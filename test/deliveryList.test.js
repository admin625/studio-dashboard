import { describe, it, expect } from 'vitest'
import { deliveryFetchScope } from '../src/components/DeliveryList.jsx'

/**
 * The guard that stops DeliveryList firing `get_delivery_summaries` before auth has settled.
 *
 * ON THE SHAPE OF THIS TEST. The work order asked for a render test ("renders with
 * resolvedStudioId null → rpc not called"). This repo cannot run one: vitest is configured with
 * no `test` block at all, so it runs in the node environment, and neither jsdom, happy-dom nor
 * @testing-library is installed. Adding them means new dependencies plus a vite.config.js change,
 * which was explicitly out of scope. So the guard is extracted as a pure decision and asserted
 * directly — same logic, same branches, existing harness. It matches how deepLink.js is tested.
 * What this does NOT cover is the wiring: that the component actually consults the decision, and
 * that the effect's dependency array re-runs on authReady. Those are read-verified, not tested.
 */
describe('deliveryFetchScope — the pre-auth guard', () => {
  it('does NOT fetch before auth is ready, even when a studio id is already present', () => {
    // The race that caused the bug: a studio id can arrive from the JWT claim before
    // AuthProvider finishes, and firing here still contends for the auth lock.
    const s = deliveryFetchScope({ authReady: false, resolvedStudioId: 'c220cc7c-bd59-444e-9d42-cd69bf4a72ec' })
    expect(s.shouldFetch).toBe(false)
    expect(s.reason).toBe('auth_not_ready')
  })

  it('does NOT fetch before auth is ready with a null studio id — the original defect', () => {
    const s = deliveryFetchScope({ authReady: false, resolvedStudioId: null })
    expect(s.shouldFetch).toBe(false)
    expect(s.studioId).toBe(null)
  })

  it('fetches exactly once with the resolved id when auth is ready', () => {
    const id = 'c220cc7c-bd59-444e-9d42-cd69bf4a72ec'
    const s = deliveryFetchScope({ authReady: true, resolvedStudioId: id })
    expect(s.shouldFetch).toBe(true)
    expect(s.studioId).toBe(id)
    expect(s.reason).toBe('studio_scope')
  })

  it('STILL fetches when auth is ready and the studio id is legitimately null (individual scope)', () => {
    // Regression guard. Gating on `resolvedStudioId` being truthy instead of on `authReady`
    // would strand individual-scope clients on a permanent spinner. Two such rows exist live.
    const s = deliveryFetchScope({ authReady: true, resolvedStudioId: null })
    expect(s.shouldFetch).toBe(true)
    expect(s.studioId).toBe(null)
    expect(s.reason).toBe('individual_scope')
  })

  it('treats empty string and undefined as "no studio", never as a queryable id', () => {
    for (const empty of ['', undefined, null]) {
      const s = deliveryFetchScope({ authReady: true, resolvedStudioId: empty })
      expect(s.studioId).toBe(null)
      expect(s.reason).toBe('individual_scope')
    }
  })

  it('negative control: the guard can actually return both answers', () => {
    // An assertion set that only ever sees one branch proves nothing.
    const blocked = deliveryFetchScope({ authReady: false, resolvedStudioId: null })
    const allowed = deliveryFetchScope({ authReady: true, resolvedStudioId: 'abc' })
    expect(blocked.shouldFetch).not.toBe(allowed.shouldFetch)
  })
})

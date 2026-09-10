// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Ordering, not outcomes.
 *
 * The auth-token lock is not a correctness bug you can see in a return value — every call
 * eventually returns something. It is a bug about WHEN two things run. Ten production reloads
 * showed `attempts=2 elapsed≈15s` while the underlying row read is 0.087 ms, because two
 * claimants were in flight together and stole the lock from each other.
 *
 * So these tests assert a SEQUENCE. They record events into one array and check relative
 * positions:
 *   1. the studio_accounts read must start AFTER the session read resolves, never beside it
 *   2. attempt 2 must start AFTER attempt 1's abort has actually fired, never while it is live
 *
 * A test that only asserted "the studio loaded" would have passed against the broken version.
 */

let order
let getSessionResolve
let singleCalls
let abortEvents
let authCb
let sessionPromise

function fakeJwt(payload) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}

const SESSION = {
  access_token: fakeJwt({ fca_studio_id: 'studio-1' }),
  user: { email: 'owner@example.com', app_metadata: { role: 'studio_owner' } },
}

function makeSupabaseMock() {
  return {
    auth: {
      getSession: vi.fn(() => sessionPromise),
      onAuthStateChange: vi.fn((cb) => { authCb = cb; return { data: { subscription: { unsubscribe() {} } } } }),
      signOut: vi.fn(),
    },
    from: vi.fn(() => {
      const chain = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.abortSignal = (signal) => {
        chain._signal = signal
        signal.addEventListener('abort', () => { abortEvents.push(`abort_${chain._n}`) })
        return chain
      }
      chain.single = () => {
        chain._n = ++singleCalls
        order.push(`studio_read_start_${chain._n}`)
        return new Promise((_res, rej) => {
          chain._signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
      }
      return chain
    }),
  }
}

describe('AuthProvider — auth-lock sequencing', () => {
  let AuthProvider, AppProvider

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    order = []; singleCalls = 0; abortEvents = []; authCb = null
    // ONE shared pending session promise per test, resolved exactly once. Handing out a fresh
    // promise per call made getSessionResolve point at whichever was created last, so resolving
    // it left the promise runRestore was actually awaiting still pending.
    let _res
    sessionPromise = new Promise(r => { _res = r })
    getSessionResolve = () => { order.push('session_resolved'); _res({ data: { session: SESSION }, error: null }) }
    const mock = makeSupabaseMock()
    vi.doMock('../src/lib/supabase.js', () => ({
      supabase: mock,
      SUPABASE_URL: 'https://x.supabase.co',
      getSessionOnce: () => mock.auth.getSession(),   // shares the one promise above
      authedJsonHeaders: async () => null,
    }))
    ;({ default: AuthProvider } = await import('../src/components/AuthProvider.jsx'))
    ;({ AppProvider } = await import('../src/context/AppContext.jsx'))
  })

  afterEach(() => { cleanup(); vi.useRealTimers(); vi.doUnmock('../src/lib/supabase.js') })

  const mount = () => render(
    <MemoryRouter initialEntries={['/deliveries']}>
      <AppProvider><AuthProvider><div>app</div></AuthProvider></AppProvider>
    </MemoryRouter>,
  )

  // waitFor() polls on REAL timers, which never advance under fake timers — it just times out.
  // Drive the clock explicitly instead: advanceTimersByTimeAsync flushes microtasks between
  // timer callbacks, so N zero-length advances walk the promise chain forward deterministically.
  const tick = async (ms = 0, times = 8) => {
    await act(async () => {
      for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(i === 0 ? ms : 0)
    })
  }

  it('does not start the studio read until the session read has resolved', async () => {
    mount()

    // The session read is deliberately still pending here. If the studio read were racing it —
    // which is what INITIAL_SESSION handling used to cause — it would already have started.
    await tick()
    expect(order).not.toContain('studio_read_start_1')

    getSessionResolve()
    await tick()

    expect(order).toContain('studio_read_start_1')
    expect(order.indexOf('session_resolved')).toBeLessThan(order.indexOf('studio_read_start_1'))
    // Exactly one claimant, not two.
    expect(singleCalls).toBe(1)
  })

  it('starts attempt 2 only after attempt 1 has actually aborted', async () => {
    mount()
    getSessionResolve()
    await tick()
    expect(order).toContain('studio_read_start_1')

    // Attempt 1 is live and its ceiling has not expired: there must be no second claimant.
    await tick(7000)
    expect(singleCalls).toBe(1)
    expect(abortEvents).toEqual([])

    // Cross the 8s ceiling: the abort fires, attempt 1 is cancelled, and only then may a
    // second attempt begin.
    await tick(1500)
    expect(singleCalls).toBe(2)

    expect(abortEvents).toContain('abort_1')
    expect(order.indexOf('studio_read_start_2')).toBeGreaterThan(order.indexOf('studio_read_start_1'))
    // The abort preceded the retry — the whole point.
    expect(abortEvents[0]).toBe('abort_1')
  })

  it('INITIAL_SESSION arriving mid-restore does NOT start a second studio read', async () => {
    // THIS is the regression. supabase-js fires INITIAL_SESSION from inside its own
    // _initialize(), i.e. while runRestore is still awaiting getSessionOnce. The old code
    // handled that event by calling initWithUser again, so two studio_accounts reads went out
    // in the same tick and fought for the auth-token lock. Against that version this test sees
    // singleCalls === 2 and fails.
    mount()
    expect(typeof authCb).toBe('function')

    // Fire it exactly as supabase-js does: before the session read has resolved.
    await act(async () => { await authCb('INITIAL_SESSION', SESSION) })
    await tick()
    expect(singleCalls).toBe(0)

    getSessionResolve()
    await tick()

    // One claimant, from runRestore, after the session resolved.
    expect(singleCalls).toBe(1)
    expect(order.indexOf('session_resolved')).toBeLessThan(order.indexOf('studio_read_start_1'))
  })

  it('a later SIGNED_IN does not overlap a restore already in flight', async () => {
    mount()
    getSessionResolve()
    await tick()
    expect(singleCalls).toBe(1)
    // Attempt 1 is still live (its promise only settles on abort). A SIGNED_IN now must JOIN
    // the in-flight init rather than start a competing read.
    //
    // Deliberately NOT awaited: joining means initOnce hands back the in-flight promise, which
    // by design does not settle until attempt 1 does. Awaiting it here would hang the test on
    // correct behaviour — an earlier draft did exactly that, timed out, and left a dangling
    // act() that broke the NEXT test too.
    let joined = false
    act(() => { authCb('SIGNED_IN', SESSION).then(() => { joined = true }) })
    await tick()
    expect(singleCalls).toBe(1)
    expect(joined).toBe(false)   // still waiting on the same read, not racing it
  })

  it('stops at two attempts', async () => {
    mount()
    getSessionResolve()
    await tick()
    expect(order).toContain('studio_read_start_1')
    await tick(9000)
    expect(singleCalls).toBe(2)
    await tick(20000)
    expect(singleCalls).toBe(2)
  })
})

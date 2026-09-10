// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import React from 'react'

/**
 * The single-flight session read, tested as a render rather than as a function.
 *
 * This is the first render test in the repo. It exists because the defect it guards is a WIRING
 * defect, invisible to a pure-function test: two components mounting in the same tick each
 * called `supabase.auth.getSession()`, supabase-js let the second steal the auth lock from the
 * first, and the first rejected with
 *
 *   Lock "lock:sb-<ref>-auth-token" was released because another request stole it
 *
 * Measured on production 2026-09-10 across ten reloads: that happened 10/10. A test that asserts
 * `getSessionOnce()` returns a promise would have passed throughout.
 *
 * The assertion is therefore a COUNT against the underlying supabase call, not against the
 * wrapper: N concurrent consumers must produce exactly ONE `supabase.auth.getSession()`.
 */

const getSessionSpy = vi.fn()

vi.mock('../src/lib/supabase.js', async () => {
  const actual = await vi.importActual('../src/lib/supabase.js')
  return actual
})

describe('getSessionOnce — single-flight', () => {
  let mod

  beforeEach(async () => {
    vi.resetModules()
    getSessionSpy.mockReset()
    // One slow, shared resolution — the shape that made the real race observable.
    getSessionSpy.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ data: { session: null }, error: null }), 30)),
    )
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ auth: { getSession: getSessionSpy, onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } }),
    }))
    mod = await import('../src/lib/supabase.js')
  })

  afterEach(() => { cleanup(); vi.doUnmock('@supabase/supabase-js') })

  it('collapses two concurrent consumers into ONE underlying getSession call', async () => {
    function Consumer({ label }) {
      const [state, setState] = React.useState('pending')
      React.useEffect(() => { mod.getSessionOnce().then(() => setState('done')) }, [])
      return <div data-testid={label}>{state}</div>
    }

    render(<><Consumer label="a" /><Consumer label="b" /></>)

    await waitFor(() => {
      expect(screen.getByTestId('a').textContent).toBe('done')
      expect(screen.getByTestId('b').textContent).toBe('done')
    })

    // The whole point. Two mounts, two awaits, ONE lock acquisition.
    expect(getSessionSpy).toHaveBeenCalledTimes(1)
  })

  it('negative control: the spy CAN count more than one, so the assertion above is meaningful', async () => {
    // Calling the raw client directly must produce two — otherwise the test above would pass
    // even if getSessionOnce were a no-op.
    await Promise.all([mod.supabase.auth.getSession(), mod.supabase.auth.getSession()])
    expect(getSessionSpy).toHaveBeenCalledTimes(2)
  })

  it('does not cache the RESULT — a later call reads fresh', async () => {
    await mod.getSessionOnce()
    await mod.getSessionOnce()
    // Sequential, not concurrent: the in-flight slot cleared on settle, so this is 2 not 1.
    // Caching the resolved session instead would survive a sign-out and serve a dead token.
    expect(getSessionSpy).toHaveBeenCalledTimes(2)
  })
})

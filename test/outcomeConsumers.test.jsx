// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/**
 * The two consumers of a run's outcome (2026-09-21 full /review, testing findings):
 *  - Dashboard must NOT show its "being created" banner over a terminal the modal is already
 *    showing — over needs_review that banner is the original false reassurance. Negative
 *    control: with no outcome (a synchronous close) the banner still appears.
 *  - DeliveryView shows the plan day from generation_posts, and a failed or throwing lookup
 *    leaves an already-loaded delivery untouched.
 */

let submitted = null
vi.mock('../src/components/GenerateModal', () => ({
  default: ({ onSubmitted }) => { submitted = onSubmitted; return null },
}))
vi.mock('../src/components/Layout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../src/components/DeliveryList', () => ({ default: () => null }))
vi.mock('../src/components/PostCard', () => ({
  default: ({ platform, index, slotDate }) => <div data-testid={`post-${platform}-${index}`}>{slotDate ? `chip:${slotDate}` : 'no-chip'}</div>,
}))
vi.mock('../src/context/AppContext', () => ({
  useApp: () => ({ authReady: true, role: 'studio_owner', brandColorPrimary: '#bd8276', scopeType: 'studio',
    resolvedStudioId: 'st-1', resolvedClientId: null }),
}))

const DELIVERY = { id: 'del-1', created_at: '2026-09-20T21:50:30Z', studio_id: 'st-1', client_id: null,
  instagram_content: [{ caption: 'a' }], facebook_content: [], twitter_content: [], linkedin_content: [], tiktok_content: [] }
let gpResult
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: async () => ({ data: [] }),
    from: (table) => {
      const q = { select: () => q, eq: () => q, not: () => q,
        single: async () => ({ data: DELIVERY, error: null }),
        then: (res, rej) => (typeof gpResult === 'function' ? Promise.reject(gpResult()) : Promise.resolve(gpResult)).then(res, rej) }
      q.table = table
      return q
    },
  },
}))

import Dashboard from '../src/pages/Dashboard.jsx'
import DeliveryView from '../src/pages/DeliveryView.jsx'

beforeEach(() => { submitted = null; gpResult = { data: [], error: null } })
afterEach(() => cleanup())

describe('Dashboard.handleGenSubmitted', () => {
  const renderDash = () => render(<MemoryRouter><Dashboard /></MemoryRouter>)
  it('needs_review from the modal: no "being created" banner', async () => {
    renderDash()
    await act(async () => { submitted(['instagram'], { phase: 'needs_review' }) })
    expect(screen.queryByText('Your content is being created')).toBeNull()
  })
  it('negative control: a synchronous close (no outcome) still shows the banner', async () => {
    renderDash()
    await act(async () => { submitted(['instagram']) })
    expect(screen.getByText('Your content is being created')).toBeTruthy()
  })
})

describe('DeliveryView plan day', () => {
  const renderView = () => render(
    <MemoryRouter initialEntries={['/delivery/del-1']}><Routes><Route path="/delivery/:id" element={<DeliveryView />} /></Routes></MemoryRouter>,
  )
  it('shows "Written for …" and the per-post chip from generation_posts', async () => {
    gpResult = { data: [{ platform: 'instagram', post_index: 0, calendar_slots: { slot_date: '2026-10-08' } }], error: null }
    renderView()
    await waitFor(() => expect(screen.getByTestId('plan-day').textContent).toBe('Written for Thu, Oct 8 on your plan'))
    expect(screen.getByTestId('post-instagram-0').textContent).toBe('chip:2026-10-08')
  })
  it('a lookup error leaves the delivery rendered, with no plan day and no error page', async () => {
    gpResult = { data: null, error: { message: 'boom' } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderView()
    await waitFor(() => expect(screen.getByTestId('post-instagram-0')).toBeTruthy())
    expect(screen.queryByTestId('plan-day')).toBeNull()
    expect(screen.queryByText('Error loading content')).toBeNull()
    warn.mockRestore()
  })
  it('a lookup that THROWS also leaves the delivery rendered (not the outer error page)', async () => {
    gpResult = () => new Error('network down')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderView()
    await waitFor(() => expect(screen.getByTestId('post-instagram-0')).toBeTruthy())
    await act(async () => {})
    expect(screen.queryByText('Error loading content')).toBeNull()
    warn.mockRestore()
  })
})

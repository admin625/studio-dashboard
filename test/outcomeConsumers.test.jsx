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
  default: ({ onSubmitted, open, regenerateOf, slotId, slotDate }) => {
    submitted = onSubmitted
    return open ? <div data-testid="regen-modal" data-slot={slotId || ''} data-slot-date={slotDate || ''}>{regenerateOf}</div> : null
  },
}))
vi.mock('../src/components/Layout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../src/components/DeliveryList', () => ({ default: () => null }))
vi.mock('../src/components/PostCard', () => ({
  default: ({ platform, index, slotDate }) => <div data-testid={`post-${platform}-${index}`}>{slotDate ? `chip:${slotDate}` : 'no-chip'}</div>,
}))
let appRole = 'studio_owner'
vi.mock('../src/context/AppContext', () => ({
  useApp: () => ({ authReady: true, role: appRole, brandColorPrimary: '#bd8276', scopeType: 'studio',
    resolvedStudioId: 'st-1', resolvedClientId: null }),
}))

const DELIVERY = { id: 'del-1', created_at: '2026-09-20T21:50:30Z', studio_id: 'st-1', client_id: null,
  instagram_content: [{ caption: 'a' }], facebook_content: [], twitter_content: [], linkedin_content: [], tiktok_content: [] }
let deliveryRow = DELIVERY
let gpResult
let regenResult // the "has this delivery been regenerated?" lookup (WO-4)
const eqCalls = [] // [table, column, value] for every .eq(), so a filter's column is under test
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: async () => ({ data: [] }),
    from: (table) => {
      const result = () => (table === 'content_deliveries' ? regenResult : gpResult)
      const q = { select: () => q, eq: (c, v) => { eqCalls.push([table, c, v]); return q }, not: () => q, limit: (n) => { eqCalls.push([table, 'limit', n]); return q },
        single: async () => ({ data: deliveryRow, error: null }),
        then: (res, rej) => { const r = result(); return (typeof r === 'function' ? Promise.reject(r()) : Promise.resolve(r)).then(res, rej) } }
      q.table = table
      return q
    },
  },
}))

import Dashboard from '../src/pages/Dashboard.jsx'
import DeliveryView from '../src/pages/DeliveryView.jsx'

beforeEach(() => { submitted = null; appRole = 'studio_owner'; eqCalls.length = 0; deliveryRow = DELIVERY; gpResult = { data: [], error: null }; regenResult = { data: [], error: null } })
afterEach(() => cleanup())

describe('Dashboard.handleGenSubmitted', () => {
  const renderDash = () => render(<MemoryRouter><Dashboard /></MemoryRouter>)
  it('failed from the modal: no "being created" banner', async () => {
    renderDash()
    await act(async () => { submitted(['instagram'], { phase: 'failed' }) })
    expect(screen.queryByText('Your content is being created')).toBeNull()
  })
  it('flagged from the modal is a delivery: no "being created" banner either', async () => {
    renderDash()
    await act(async () => { submitted(['instagram'], { phase: 'flagged', deliveryId: 'd', flag: { reason: 'quality_unresolved' } }) })
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


describe('DeliveryView: the WO-4 flag (D4)', () => {
  const renderView = () => render(
    <MemoryRouter initialEntries={['/delivery/del-1']}><Routes><Route path="/delivery/:id" element={<DeliveryView />} /></Routes></MemoryRouter>,
  )
  const flagged = (extra = {}) => ({ ...DELIVERY, quality_flag: true, flag_reason: 'banned_phrase', flag_phrase: 'beast mode', regenerated_from: null, ...extra })
  const PROMISES = /human look|notified|will look|look at it|human review|What the check flagged/i

  it('a flagged original: label, the approved line, and Regenerate, which opens the modal bound to this delivery', async () => {
    deliveryRow = flagged()
    renderView()
    const box = await screen.findByTestId('quality-flag')
    expect(box.textContent).toContain('Check before posting')
    expect(box.textContent).toContain("This post uses a phrase you or we flagged: 'beast mode'. Edit it or regenerate.")
    expect(document.body.textContent).not.toMatch(PROMISES)
    await act(async () => { screen.getByRole('button', { name: /^regenerate$/i }).click() })
    expect(screen.getByTestId('regen-modal').textContent).toBe('del-1')
  })

  it('negative control: rows with no flag fields (pre-M3), or quality_flag false, render no flag and no Regenerate', async () => {
    for (const row of [DELIVERY, { ...DELIVERY, quality_flag: false, flag_reason: null }]) {
      cleanup()
      deliveryRow = row
      renderView()
      await waitFor(() => expect(screen.getByTestId('post-instagram-0')).toBeTruthy())
      expect(screen.queryByTestId('quality-flag')).toBeNull()
      expect(screen.queryByRole('button', { name: /^regenerate$/i })).toBeNull()
    }
  })

  it('a flagged REGENERATE shows the flag but offers no Regenerate (the chain stops at one)', async () => {
    deliveryRow = flagged({ flag_reason: 'error_fallback', flag_phrase: null, regenerated_from: 'orig-1' })
    renderView()
    const box = await screen.findByTestId('quality-flag')
    expect(box.textContent).toContain('This is our first draft. Give it a read, or regenerate.')
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).toBeNull()
  })

  it('an original that was already regenerated links to the regenerate instead of offering another', async () => {
    deliveryRow = flagged()
    regenResult = { data: [{ id: 'del-2' }], error: null }
    renderView()
    const link = await screen.findByRole('link', { name: /open the regenerated post/i })
    expect(link.getAttribute('href')).toBe('/delivery/del-2')
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).toBeNull()
  })

  it('the regenerate lookup filters on regenerated_from = this delivery, limit 1 (the column is under test)', async () => {
    deliveryRow = flagged()
    renderView()
    await screen.findByTestId('quality-flag')
    await waitFor(() => expect(eqCalls).toContainEqual(['content_deliveries', 'regenerated_from', 'del-1']))
    expect(eqCalls).toContainEqual(['content_deliveries', 'limit', 1])
  })

  it('negative control: an unflagged delivery runs no regenerate lookup at all', async () => {
    renderView()
    await waitFor(() => expect(screen.getByTestId('post-instagram-0')).toBeTruthy())
    expect(eqCalls.some(([t, c]) => t === 'content_deliveries' && c === 'regenerated_from')).toBe(false)
  })

  it('a non-owner (instructor) sees the flag but no Regenerate and no modal', async () => {
    appRole = 'studio_instructor'
    deliveryRow = flagged()
    renderView()
    await screen.findByTestId('quality-flag')
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).toBeNull()
    expect(screen.queryByTestId('regen-modal')).toBeNull()
  })

  it('once the regenerate delivers, the original links to it instead of offering Regenerate again', async () => {
    deliveryRow = flagged()
    renderView()
    const btn = await screen.findByRole('button', { name: /^regenerate$/i })
    await act(async () => { btn.click() })
    await act(async () => { submitted(['instagram'], { phase: 'flagged', deliveryId: 'del-2', flag: {} }) })
    const link = await screen.findByRole('link', { name: /open the regenerated post/i })
    expect(link.getAttribute('href')).toBe('/delivery/del-2')
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).toBeNull()
  })

  it("a regenerate keeps the original's slot when it is bound to exactly one (Mac 2026-10-05)", async () => {
    deliveryRow = flagged()
    gpResult = { data: [{ platform: 'instagram', post_index: 0, slot_id: 'slot-1', calendar_slots: { slot_date: '2026-10-08' } }], error: null }
    renderView()
    await waitFor(() => expect(screen.getByTestId('plan-day')).toBeTruthy())
    await act(async () => { screen.getByRole('button', { name: /^regenerate$/i }).click() })
    const m = screen.getByTestId('regen-modal')
    expect(m.dataset.slot).toBe('slot-1')
    expect(m.dataset.slotDate).toBe('2026-10-08')
  })

  it('negative control: a delivery bound to two slots, or none, regenerates unbound', async () => {
    for (const data of [
      [{ platform: 'instagram', post_index: 0, slot_id: 'slot-1', calendar_slots: { slot_date: '2026-10-08' } },
        { platform: 'instagram', post_index: 1, slot_id: 'slot-2', calendar_slots: { slot_date: '2026-10-09' } }],
      [],
    ]) {
      cleanup()
      deliveryRow = flagged()
      gpResult = { data, error: null }
      renderView()
      const btn = await screen.findByRole('button', { name: /^regenerate$/i })
      await act(async () => {})
      await act(async () => { btn.click() })
      expect(screen.getByTestId('regen-modal').dataset.slot).toBe('')
    }
  })

  it('a failed regenerate lookup leaves Regenerate on (the proxy is the real check) and the page intact', async () => {
    deliveryRow = flagged()
    regenResult = { data: null, error: { message: 'boom' } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderView()
    await screen.findByTestId('quality-flag')
    await waitFor(() => expect(screen.getByRole('button', { name: /^regenerate$/i })).toBeTruthy())
    expect(screen.queryByText('Error loading content')).toBeNull()
    warn.mockRestore()
  })
})
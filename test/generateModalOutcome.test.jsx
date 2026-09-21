// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act, within } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Item 7, HQ 2026-09-21: "needs review" must reach the owner.
 *
 * On 2026-09-20 Katie tapped three slots. Two runs (71021, 71024) failed review twice and
 * delivered nothing; the third delivered. The proxy had answered 202 at 25s for all three,
 * and the modal closed on that 202 every time — the failures were invisible by construction.
 *
 * These drive the REAL modal through the REAL sequence: a 202 from generate-content, then the
 * attempt row as the generator actually wrote it (disposable-copy exec 71271). The negative
 * control is the owner-initiated path, which must still close on the first 2xx exactly as before.
 */

const REAL_NEEDS_REVIEW = {
  outcome: 'needs_review',
  outcome_detail: { notes: 'Deliberate failure: item-7 needs-review receipt.', slot_id: '2073eacd-78ab-4c80-ab88-18e6612b11c7', iterations: 2, failed_criteria: ['hqtest_forced_fail'] },
  delivery_id: null,
}

const attemptRows = []
const rowsById = {}
const fromCalls = []
vi.mock('../src/lib/supabase', () => ({
  getSessionOnce: async () => ({ data: { session: { access_token: 'tok' } } }),
  supabase: {
    from: (table) => {
      fromCalls.push(table)
      const q = {
        select: () => q, eq: (col, val) => { q._eq = [col, val]; return q },
        maybeSingle: async () => {
          const byId = rowsById[q._eq && q._eq[1]]
          if (byId) return { data: byId.length > 1 ? byId.shift() : byId[0], error: null }
          return { data: attemptRows.length ? attemptRows.shift() : REAL_NEEDS_REVIEW, error: null }
        },
      }
      return q
    },
  },
}))
const appState = {}
const BASE_APP = {
  authReady: true, role: 'studio_owner', brandColorPrimary: '#bd8276', brandVoice: 'We are community-focused.',
  aiPhotoPrompt: '', studioLoadError: false, email: 'owner@example.com',
  resolvedStudioId: '948e26f4-5996-4e11-9b86-c89664b0e600', resolvedClientId: null,
  photoSource: 'studio_only', studioName: 'The Local Kollective', studioType: 'studio', lastContentTypes: [],
}
vi.mock('../src/context/AppContext', () => ({ useApp: () => appState }))

import GenerateModal from '../src/components/GenerateModal.jsx'

let fetchBodies
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  Object.keys(appState).forEach((k) => delete appState[k])
  Object.assign(appState, BASE_APP)
  attemptRows.length = 0
  Object.keys(rowsById).forEach((k) => delete rowsById[k])
  fromCalls.length = 0
  fetchBodies = []
  global.fetch = vi.fn(async (_url, opts) => {
    fetchBodies.push(JSON.parse(opts.body))
    // generate-content.js's 25s-abort answer, verbatim.
    return { ok: true, status: 202, json: async () => ({ success: true, message: 'Content generation in progress. Results will appear in your deliveries.' }) }
  })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

function setup(props = {}) {
  const p = { open: true, onClose: vi.fn(), onSubmitted: vi.fn(), ...props }
  render(<MemoryRouter><GenerateModal {...p} /></MemoryRouter>)
  return p
}
const submit = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /create content/i })) }) }

describe('slot run: the outcome reaches the modal', () => {
  it('202, then the real needs_review row → "needs a human look", nothing hidden, no retry', async () => {
    const p = setup({ slotId: '2073eacd-78ab-4c80-ab88-18e6612b11c7', slotDate: '2026-10-05', slotJobLabel: 'Getting to know us' })
    attemptRows.push(null, { outcome: null, outcome_detail: null, delivery_id: null })
    await submit()

    expect(screen.getByRole('status').dataset.outcome).toBe('generating')
    expect(screen.getByText(/Writing your post for Mon, Oct 5/)).toBeTruthy()
    expect(p.onClose).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 4000) })

    const status = screen.getByRole('status')
    expect(status.dataset.outcome).toBe('needs_review')
    expect(screen.getByText('This one needs a human look.')).toBeTruthy()
    expect(screen.getByText(/didn't pass our quality check after two tries, so nothing was delivered/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /try again|retry/i })).toBeNull()
    expect(p.onClose).not.toHaveBeenCalled()
    expect(p.onSubmitted).toHaveBeenCalledTimes(1)
    expect(p.onSubmitted.mock.calls[0][1].phase).toBe('needs_review')
    expect(fromCalls.every((t) => t === 'generation_attempts')).toBe(true)
  })

  it('sends slot_id and a uuid client_request_id — and still no slot date, job or reason', async () => {
    setup({ slotId: '2073eacd-78ab-4c80-ab88-18e6612b11c7', slotDate: '2026-10-05', slotRationale: 'r', slotJobLabel: 'j' })
    await submit()
    const b = fetchBodies[0]
    expect(b.slot_id).toBe('2073eacd-78ab-4c80-ab88-18e6612b11c7')
    expect(b.client_request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(b).not.toHaveProperty('slot_date')
    expect(b).not.toHaveProperty('rationale')
  })

  it('a delivered run offers the post and states the plan day', async () => {
    setup({ slotId: 's', slotDate: '2026-10-08' })
    attemptRows.push({ outcome: 'delivered', delivery_id: 'dddddddd-0000-0000-0000-000000000000', outcome_detail: null })
    await submit()
    expect(screen.getByRole('status').dataset.outcome).toBe('delivered')
    expect(screen.getByText('Written for Thu, Oct 8.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /open the post/i })).toBeTruthy()
  })

  it("a synchronous needs_review body (the 71021 shape, no 'error' key) is shown, not read as success", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, needs_review: true, generated: false, delivered: false, iterations: 2, failed_criteria: ['no_generic_cliches'], notes: 'n', message: 'm' }) }))
    const p = setup({ slotId: 's', slotDate: '2026-10-05' })
    await submit()
    expect(screen.getByRole('status').dataset.outcome).toBe('needs_review')
    expect(fromCalls).toEqual([]) // terminal already known; no poll
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('closing clears the outcome, so the next slot does not open on the last result', async () => {
    const p = setup({ slotId: 's', slotDate: '2026-10-05' })
    attemptRows.push(REAL_NEEDS_REVIEW)
    await submit()
    expect(screen.getByRole('status').dataset.outcome).toBe('needs_review')
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: /^close$/i }))
    expect(p.onClose).toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('owner-initiated run: the same modal, the same fix (HQ 2026-09-21)', () => {
  it('202 → polls → needs review is shown, not a success banner', async () => {
    const p = setup()
    attemptRows.push({ outcome: null, outcome_detail: null, delivery_id: null })
    await submit()
    expect(fetchBodies[0].client_request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(fetchBodies[0]).not.toHaveProperty('slot_id')
    expect(screen.getByRole('status').dataset.outcome).toBe('generating')
    expect(screen.getByText(/Writing your content…/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 4000) })
    expect(screen.getByRole('status').dataset.outcome).toBe('needs_review')
    expect(screen.getByText(/Your content didn't pass our quality check/)).toBeTruthy()
    expect(p.onClose).not.toHaveBeenCalled()
    expect(p.onSubmitted.mock.calls[0][1].phase).toBe('needs_review')
  })

  it('a synchronous needs_review body is shown on the owner-initiated path too', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, needs_review: true, iterations: 2, failed_criteria: ['voice_match'], notes: 'n' }) }))
    const p = setup()
    await submit()
    expect(screen.getByRole('status').dataset.outcome).toBe('needs_review')
    expect(p.onClose).not.toHaveBeenCalled()
  })
})

describe('review findings (2026-09-21 /review)', () => {
  it('close mid-run hands back to the old banner path: onSubmitted(platforms) with no outcome', async () => {
    const p = setup()
    attemptRows.push({ outcome: null })
    await submit()
    expect(screen.getByRole('status').dataset.outcome).toBe('generating')
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
    expect(p.onSubmitted).toHaveBeenCalledWith(['instagram'])
  })

  it('a poll left sleeping by close-reopen-resubmit cannot land its result on the new run', async () => {
    const p = setup()
    // Run 1: stays open for one tick, then would report needs_review.
    let n = 0
    global.fetch = vi.fn(async (_u, o) => {
      const b = JSON.parse(o.body); fetchBodies.push(b); n += 1
      rowsById[b.client_request_id] = n === 1
        ? [{ outcome: null }, REAL_NEEDS_REVIEW]
        : [{ outcome: 'delivered', delivery_id: 'dddddddd-0000-0000-0000-000000000002' }]
      return { ok: true, status: 202, json: async () => ({ success: true }) }
    })
    await submit()
    expect(screen.getByRole('status').dataset.outcome).toBe('generating')
    fireEvent.click(screen.getByRole('button', { name: /^close$/i })) // run 1 left sleeping
    await submit() // run 2, same mounted modal
    expect(screen.getByRole('status').dataset.outcome).toBe('delivered')
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 4000) }) // run 1 wakes
    expect(screen.getByRole('status').dataset.outcome).toBe('delivered')
    expect(p.onSubmitted.mock.calls.some((c) => c[1] && c[1].phase === 'needs_review')).toBe(false)
  })

  it('no crypto.randomUUID: no correlation id, and the modal does not hang on "Creating…"', async () => {
    const orig = globalThis.crypto.randomUUID
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      const p = setup()
      await submit()
      expect(fetchBodies[0]).not.toHaveProperty('client_request_id')
      expect(p.onClose).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: orig, configurable: true })
    }
  })
})

describe('NEGATIVE CONTROL — only a 202 polls', () => {
  // The generator's delivered path ends at Mark Delivered; this is its answer inside 25s.
  const SYNC_DELIVERED = { ok: true, status: 200, json: async () => ({ outcome_marked: true, delivery_id: 'dddddddd-0000-0000-0000-000000000000' }) }

  it('owner-initiated: a synchronous 2xx delivery closes immediately and never polls', async () => {
    global.fetch = vi.fn(async (_u, o) => { fetchBodies.push(JSON.parse(o.body)); return SYNC_DELIVERED })
    const p = setup()
    await submit()
    expect(p.onClose).toHaveBeenCalledTimes(1)
    expect(p.onSubmitted.mock.calls[0][1]).toBeUndefined() // the original banner-and-poll path
    expect(fromCalls).toEqual([])
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('slot-bound: a synchronous 2xx delivery closes immediately and never polls', async () => {
    global.fetch = vi.fn(async () => SYNC_DELIVERED)
    const p = setup({ slotId: 's', slotDate: '2026-10-05' })
    await submit()
    expect(p.onClose).toHaveBeenCalledTimes(1)
    expect(fromCalls).toEqual([])
  })

  it('no studio (individual scope): no correlation id, closes on the 202 as before', async () => {
    appState.resolvedStudioId = null
    appState.resolvedClientId = 'c1'
    const p = setup()
    await submit()
    expect(fetchBodies[0]).not.toHaveProperty('client_request_id')
    expect(p.onClose).toHaveBeenCalledTimes(1)
    expect(fromCalls).toEqual([])
  })
})

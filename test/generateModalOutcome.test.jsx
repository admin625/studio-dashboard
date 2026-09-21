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
 * attempt row as the generator actually wrote it (disposable-copy exec 71271). Negative controls:
 * a synchronous 2xx delivery still closes at once (slot-bound and owner-initiated), and an
 * individual-scope run (no studio, no client_request_id) keeps the old close-on-202.
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
    rpc: async (fn, args) => {
      fromCalls.push(fn)
      const byId = rowsById[args && args.p_client_request_id]
      const row = byId ? (byId.length > 1 ? byId.shift() : byId[0]) : (attemptRows.length ? attemptRows.shift() : { outcome: null, outcome_detail: null, delivery_id: null })
      return { data: row ? [row] : [], error: null }
    },
    from: (table) => {
      fromCalls.push(table)
      const q = {
        select: () => q, eq: (col, val) => { q._eq = [col, val]; return q },
        maybeSingle: async () => {
          const byId = rowsById[q._eq && q._eq[1]]
          if (byId) return { data: byId.length > 1 ? byId.shift() : byId[0], error: null }
          // Default is an OPEN row, never a terminal: a test must queue the outcome it asserts.
          return { data: attemptRows.length ? attemptRows.shift() : { outcome: null, outcome_detail: null, delivery_id: null }, error: null }
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
const REAL_FETCH = global.fetch
afterEach(() => { cleanup(); vi.useRealTimers(); global.fetch = REAL_FETCH })

function setup(props = {}) {
  const p = { open: true, onClose: vi.fn(), onSubmitted: vi.fn(), ...props }
  render(<MemoryRouter><GenerateModal {...p} /></MemoryRouter>)
  return p
}
const panel = () => document.querySelector('[data-outcome]')
const phase = () => panel() && panel().dataset.outcome
const submit = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /create content/i })) }) }

describe('slot run: the outcome reaches the modal', () => {
  it('202, then the real needs_review row → "needs a human look", nothing hidden, no retry', async () => {
    const p = setup({ slotId: '2073eacd-78ab-4c80-ab88-18e6612b11c7', slotDate: '2026-10-05', slotJobLabel: 'Getting to know us' })
    attemptRows.push(null, { outcome: null, outcome_detail: null, delivery_id: null }, REAL_NEEDS_REVIEW)
    await submit()

    expect(phase()).toBe('generating')
    expect(screen.getByText(/Writing your post for Mon, Oct 5/)).toBeTruthy()
    expect(p.onClose).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 4000) })

    expect(phase()).toBe('needs_review')
    expect(screen.getByText('This one needs a human look.')).toBeTruthy()
    expect(screen.getByText(/didn't pass our quality check after two tries, so nothing was delivered/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /try again|retry/i })).toBeNull()
    expect(p.onClose).not.toHaveBeenCalled()
    expect(p.onSubmitted).toHaveBeenCalledTimes(1)
    expect(p.onSubmitted.mock.calls[0][1].phase).toBe('needs_review')
    expect(fromCalls.every((t) => t === 'get_generation_outcome')).toBe(true)
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
    expect(phase()).toBe('delivered')
    expect(screen.getByText('Written for Thu, Oct 8.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /open the post/i })).toBeTruthy()
  })

  it("a synchronous needs_review body (the 71021 shape, no 'error' key) is shown, not read as success", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, needs_review: true, generated: false, delivered: false, iterations: 2, failed_criteria: ['no_generic_cliches'], notes: 'n', message: 'm' }) }))
    const p = setup({ slotId: 's', slotDate: '2026-10-05' })
    await submit()
    expect(phase()).toBe('needs_review')
    expect(fromCalls).toEqual([]) // terminal already known; no poll
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('closing clears the outcome, so the next slot does not open on the last result', async () => {
    const p = setup({ slotId: 's', slotDate: '2026-10-05' })
    attemptRows.push(REAL_NEEDS_REVIEW)
    await submit()
    expect(phase()).toBe('needs_review')
    fireEvent.click(within(panel()).getByRole('button', { name: /^close$/i }))
    expect(p.onClose).toHaveBeenCalled()
    expect(panel()).toBeNull()
  })
})

describe('owner-initiated run: the same modal, the same fix (HQ 2026-09-21)', () => {
  it('202 → polls → needs review is shown, not a success banner', async () => {
    const p = setup()
    attemptRows.push({ outcome: null, outcome_detail: null, delivery_id: null }, REAL_NEEDS_REVIEW)
    await submit()
    expect(fetchBodies[0].client_request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(fetchBodies[0]).not.toHaveProperty('slot_id')
    expect(phase()).toBe('generating')
    expect(screen.getByText(/Writing your content…/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 4000) })
    expect(phase()).toBe('needs_review')
    expect(screen.getByText(/Your content didn't pass our quality check/)).toBeTruthy()
    expect(p.onClose).not.toHaveBeenCalled()
    expect(p.onSubmitted.mock.calls[0][1].phase).toBe('needs_review')
  })

  it('a synchronous needs_review body is shown on the owner-initiated path too', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, needs_review: true, iterations: 2, failed_criteria: ['voice_match'], notes: 'n' }) }))
    const p = setup()
    await submit()
    expect(phase()).toBe('needs_review')
    expect(p.onClose).not.toHaveBeenCalled()
  })
})

describe('review findings (2026-09-21 /review)', () => {
  it('close mid-run hands back to the old banner path: onSubmitted(platforms) with no outcome', async () => {
    const p = setup()
    attemptRows.push({ outcome: null })
    await submit()
    expect(phase()).toBe('generating')
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
    expect(phase()).toBe('generating')
    fireEvent.click(screen.getByRole('button', { name: /^close$/i })) // run 1 left sleeping
    await submit() // run 2, same mounted modal
    expect(phase()).toBe('delivered')
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 4000) }) // run 1 wakes
    expect(phase()).toBe('delivered')
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
    expect(panel()).toBeNull()
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

describe('every terminal state renders honestly (2026-09-21 full /review)', () => {
  it('refused shows the generator\'s message and no Open button', async () => {
    setup({ slotId: 's', slotDate: '2026-10-05' })
    attemptRows.push({ outcome: 'refused', outcome_detail: { message: 'This slot is on a manual hold.' }, delivery_id: null })
    await submit()
    expect(phase()).toBe('refused')
    expect(screen.getByText('This slot is on a manual hold.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull()
  })
  it('failed says where to retry (there is no retry button) and makes support tappable', async () => {
    setup({ slotId: 's', slotDate: '2026-10-05' })
    attemptRows.push({ outcome: 'failed', outcome_detail: { error: 'prompt_field_missing' }, delivery_id: null })
    await submit()
    expect(screen.getByText(/Close this and tap the day on your plan to try again\./)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'admin@fiorsaoirse.com' }).getAttribute('href')).toBe('mailto:admin@fiorsaoirse.com')
  })
  it('no row for 10 minutes is "we haven\'t heard back" with a way to Deliveries — never "nothing was created"', async () => {
    setup()
    await submit() // every read: open row / nothing terminal
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 4000) })
    expect(screen.getByText("We haven't heard back.")).toBeTruthy()
    expect(screen.getByText(/hasn't reported back in 10 minutes/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /go to deliveries/i })).toBeTruthy()
    expect(screen.queryByText(/nothing was created/)).toBeNull()
  })
})

describe('the proxy lost the answer, not the run (2026-09-21 full /review)', () => {
  it('504 from generate-content follows the run instead of claiming it failed', async () => {
    global.fetch = vi.fn(async (_u, o) => { fetchBodies.push(JSON.parse(o.body)); return { ok: false, status: 504, json: async () => ({}) } })
    setup({ slotId: 's', slotDate: '2026-10-05' })
    attemptRows.push({ outcome: null }, REAL_NEEDS_REVIEW)
    await submit()
    expect(screen.getByText(/We lost the connection while sending this/)).toBeTruthy()
    expect(screen.queryByText(/couldn't submit/)).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 4000) })
    expect(screen.getByText('This one needs a human look.')).toBeTruthy()
  })
  it("negative control: the proxy's OWN 502 (it never reached n8n) is shown as an error, and nothing polls", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: 'Could not verify your studio. Please try again.' }) }))
    setup({ slotId: 's', slotDate: '2026-10-05' })
    await submit()
    expect(screen.getByText(/Could not verify your studio. Please try again./)).toBeTruthy()
    expect(screen.queryByText(/We lost the connection/)).toBeNull()
    expect(fromCalls).toEqual([])
  })
  it('negative control: a 403 is still a plain error, and nothing polls', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'You do not have access to that studio.' }) }))
    setup({ slotId: 's', slotDate: '2026-10-05' })
    await submit()
    expect(screen.getByText(/couldn't submit your request \(status 403/)).toBeTruthy()
    expect(fromCalls).toEqual([])
  })
  it('our own 30s abort follows the run when there is a request id', async () => {
    global.fetch = vi.fn((_u, o) => new Promise((_res, rej) => { o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) }) }))
    setup({ slotId: 's', slotDate: '2026-10-05' })
    attemptRows.push({ outcome: 'delivered', delivery_id: 'dddddddd-0000-0000-0000-000000000003' })
    await submit()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(screen.queryByText(/Request timed out/)).toBeNull()
    expect(screen.getByText('Written for Mon, Oct 5.')).toBeTruthy()
  })
})

describe('lifecycle and focus (2026-09-21 full /review)', () => {
  it('unmounting mid-poll stops the poll and never reports an outcome', async () => {
    const p = setup()
    const { unmount } = { unmount: () => cleanup() }
    await submit()
    const reads = fromCalls.length
    unmount()
    attemptRows.push(REAL_NEEDS_REVIEW)
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 4000) })
    expect(fromCalls.length).toBeLessThanOrEqual(reads + 1)
    expect(p.onSubmitted.mock.calls.some((c) => c[1])).toBe(false)
  })
  it('focus moves to the result heading when the form is hidden', async () => {
    setup({ slotId: 's', slotDate: '2026-10-05' })
    attemptRows.push(REAL_NEEDS_REVIEW)
    await submit()
    expect(document.activeElement.textContent).toBe('This one needs a human look.')
  })
})

describe('HQ 2026-09-21 item 2: entitlement refusals are shown, not closed as success', () => {
  // Verbatim shape of the new Respond Refused Entitlement node's answer (no attempt row exists on
  // this path, so it can only arrive synchronously).
  const TRIAL = { ok: false, refused: true, generated: false, delivered: false, code: 'trial_limit_reached',
    message: "You've used all the posts in your free trial, so nothing was created. Subscribe to keep creating." }
  it('owner-initiated: trial limit reached → refused panel with its message, modal stays open', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => TRIAL }))
    const p = setup()
    await submit()
    expect(phase()).toBe('refused')
    expect(screen.getByText("We couldn't create this right now.")).toBeTruthy()
    expect(screen.getByText(TRIAL.message)).toBeTruthy()
    expect(p.onClose).not.toHaveBeenCalled()
    expect(p.onSubmitted.mock.calls[0][1].phase).toBe('refused') // Dashboard: no "being created" banner
    expect(fromCalls).toEqual([])
  })
  it('negative control (unchanged): a real synchronous delivery still closes', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ outcome_marked: true, delivery_id: 'dddddddd-0000-0000-0000-000000000009' }) }))
    const p = setup()
    await submit()
    expect(p.onClose).toHaveBeenCalledTimes(1)
    expect(panel()).toBeNull()
  })
})

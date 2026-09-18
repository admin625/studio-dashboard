// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { SlotPanel } from '../src/pages/Calendar.jsx'

/**
 * WHY THIS FILE EXISTS
 * --------------------
 * Rehearsal blocker 2, 2026-09-18: the slot rationale was editable and could not be
 * saved. Not because the write was broken — `calendar_slot_rationales` accepts the
 * insert fine — but because the only control that triggered it was labelled
 * "That reason's right" and did double duty, saving when the text had changed and
 * recording `accepted` when it had not. The owner closed the panel and her words were
 * gone.
 *
 * That table held ZERO rows across every studio for the entire life of the feature.
 *
 * THE FAILURE MODE IS SILENCE, which is what makes this render-tested rather than
 * reasoned about. Every version of this panel — the broken one included — renders a
 * textarea you can type into and closes without complaint. Nothing in a return value
 * distinguishes "saved" from "discarded"; only the sequence of what got called and
 * what got shown does. So these assert BEHAVIOUR AT THE CONTROL, not outcomes:
 *
 *   1. save is its own control, and is inert until there is a real change to save
 *   2. saving calls onReason with the owner's text and does NOT close the panel
 *   3. the confirmation is visible, and goes stale the moment she types again
 *   4. a dirty draft is never discarded without being asked
 *   5. "That reason's right" no longer saves — the overload that caused all this
 *
 * A test that only asserted "onReason was called" would pass against the broken
 * version, because the broken version did call it — just from a control nobody could
 * find.
 */

const SLOT = {
  id: '11111111-2222-3333-4444-555555555555',
  slot_date: '2026-10-05',
  job_label: 'Getting to know us',
  reason: 'Monday needs a warm welcome post.',
  reason_source: 'planner',
  post_id: null,
}

function setup(overrides = {}) {
  const props = {
    slot: SLOT,
    primary: '#bd8276',
    onClose: vi.fn(),
    onAct: vi.fn().mockResolvedValue(undefined),
    onReason: vi.fn().mockResolvedValue(undefined),
    onGenerate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  render(<SlotPanel {...props} />)
  return props
}

const saveBtn = () => screen.getByRole('button', { name: /save reason/i })
const closeBtn = () => screen.getByRole('button', { name: /close/i })
const textarea = () => screen.getByLabelText(/why this post/i)
const type = (value) => fireEvent.change(textarea(), { target: { value } })

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup() })

describe('SlotPanel — the save control exists and is discoverable', () => {
  it('renders a control that says "Save reason"', () => {
    setup()
    // The literal label matters. "That reason's right" is agreement with what is
    // already there; it is not a save, and reading it as one is the whole defect.
    expect(saveBtn()).toBeTruthy()
  })

  it('is disabled until the text actually changes', () => {
    setup()
    expect(saveBtn().disabled).toBe(true)
    type('Monday needs a warm welcome post, in my words.')
    expect(saveBtn().disabled).toBe(false)
  })

  it('stays disabled for a whitespace-only change — that is not an edit', () => {
    setup()
    type('  Monday needs a warm welcome post.  ')
    expect(saveBtn().disabled).toBe(true)
  })

  it('refuses to save an empty reason', () => {
    setup()
    type('   ')
    expect(saveBtn().disabled).toBe(true)
    expect(screen.getByText(/can't be empty/i)).toBeTruthy()
  })
})

describe('SlotPanel — saving persists and confirms', () => {
  it('calls onReason with the trimmed text', async () => {
    const p = setup()
    type('  Because our Monday regulars bring friends.  ')
    await act(async () => { fireEvent.click(saveBtn()) })
    expect(p.onReason).toHaveBeenCalledTimes(1)
    expect(p.onReason).toHaveBeenCalledWith('Because our Monday regulars bring friends.')
  })

  it('does NOT close the panel on success', async () => {
    // THE REGRESSION. Closing on success is what made a save indistinguishable from
    // a discard: the panel vanished either way, so "it closed" told the owner nothing.
    const p = setup()
    type('Because our Monday regulars bring friends.')
    await act(async () => { fireEvent.click(saveBtn()) })
    expect(p.onClose).not.toHaveBeenCalled()
    expect(saveBtn()).toBeTruthy()
  })

  it('shows a visible confirmation, and disables save again', async () => {
    setup()
    type('Because our Monday regulars bring friends.')
    await act(async () => { fireEvent.click(saveBtn()) })
    expect(screen.getByText(/saved/i)).toBeTruthy()
    expect(saveBtn().disabled).toBe(true)
  })

  it('drops the confirmation as soon as she types again', async () => {
    // A "Saved" label sitting above unsaved text is the same lie in a new costume.
    setup()
    type('Because our Monday regulars bring friends.')
    await act(async () => { fireEvent.click(saveBtn()) })
    expect(screen.queryByText(/saved/i)).toBeTruthy()
    type('Because our Monday regulars bring friends, and it works.')
    expect(screen.queryByText(/^saved/i)).toBeNull()
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy()
  })

  it('surfaces a failed save instead of pretending it worked', async () => {
    const p = setup({ onReason: vi.fn().mockRejectedValue(new Error('Could not save that reason.')) })
    type('Because our Monday regulars bring friends.')
    await act(async () => { fireEvent.click(saveBtn()) })
    expect(screen.getByText(/could not save that reason/i)).toBeTruthy()
    expect(p.onClose).not.toHaveBeenCalled()
    // Still dirty, so she can retry without retyping.
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy()
  })
})

describe('SlotPanel — an unsaved draft is never lost silently', () => {
  it('closes immediately when nothing has been edited', () => {
    const p = setup()
    fireEvent.click(closeBtn())
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('asks before discarding a dirty draft, and does not close on its own', () => {
    const p = setup()
    type('Something she is part way through writing')
    fireEvent.click(closeBtn())
    expect(p.onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/haven't saved it/i)).toBeTruthy()
  })

  it('"Keep editing" returns her to the draft with the text intact', () => {
    const p = setup()
    type('Something she is part way through writing')
    fireEvent.click(closeBtn())
    fireEvent.click(screen.getByRole('button', { name: /keep editing/i }))
    expect(p.onClose).not.toHaveBeenCalled()
    expect(textarea().value).toBe('Something she is part way through writing')
  })

  it('"Discard my changes" is the only path that throws the edit away', () => {
    const p = setup()
    type('Something she is part way through writing')
    fireEvent.click(closeBtn())
    fireEvent.click(screen.getByRole('button', { name: /discard my changes/i }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('a saved edit closes cleanly — the guard is about UNSAVED work, not any work', async () => {
    const p = setup()
    type('Because our Monday regulars bring friends.')
    await act(async () => { fireEvent.click(saveBtn()) })
    fireEvent.click(closeBtn())
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })
})

describe('SlotPanel — the overload that caused blocker 2 is gone', () => {
  it('"That reason\'s right" records acceptance and never saves', async () => {
    const p = setup()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /that reason's right/i }))
    })
    expect(p.onAct).toHaveBeenCalledWith('accepted')
    expect(p.onReason).not.toHaveBeenCalled()
  })

  it('is disabled while there are unsaved edits', () => {
    // Accepting a reason she has just rewritten but not saved would record agreement
    // with the OLD wording — the exact confusion this panel is being rebuilt to end.
    setup()
    type('Rewritten, not yet saved')
    expect(screen.getByRole('button', { name: /that reason's right/i }).disabled).toBe(true)
    expect(screen.getByText(/save your reason first/i)).toBeTruthy()
  })

  it('becomes available again once the edit is saved', async () => {
    setup()
    type('Rewritten, then saved')
    await act(async () => { fireEvent.click(saveBtn()) })
    expect(screen.getByRole('button', { name: /that reason's right/i }).disabled).toBe(false)
  })
})

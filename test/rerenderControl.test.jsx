// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import { RerenderControl } from '../src/pages/Reels.jsx'

/**
 * WHY THIS FILE EXISTS
 * --------------------
 * 2026-09-23 live proof, Mac Test Studio v2 reel 8ff638b4: the studio edited the hook,
 * tapped Render again, and the render went out with the ORIGINAL hook. reel_hook_captures
 * recorded hook_edited = false. Nothing errored. The counter moved, a real render was
 * spent, and the edit was silently discarded.
 *
 * test/reelsRerender.test.js already proved foldHookIntoEdl() keeps the original proposal
 * GIVEN a hook_text. It never proved the control DELIVERS one. That gap is the whole bug:
 * a unit test on the server half cannot see an edit that dies in the browser.
 *
 * This is the same failure class as test/slotReasonSave.test.jsx — an owner's typed words
 * discarded with no error — which is why it is render-tested at the control, not reasoned
 * about. Every version of this control, broken included, renders a box you can type in.
 */

const reel = { reel_id: 'r1', hook: 'Dial in your form - we cue every rep with you', render_count: 1 }
const box = () => screen.getByRole('textbox')
const btn = () => screen.getByRole('button', { name: /render again/i })

afterEach(cleanup)

describe('RerenderControl delivers the hook the studio actually typed', () => {
  it('sends the EDITED text, not the seeded original', () => {
    const onRerender = vi.fn()
    render(<RerenderControl reel={reel} primary="#000" busy={false} onRerender={onRerender} />)
    fireEvent.change(box(), { target: { value: 'Dial in your form and the strength follows' } })
    fireEvent.click(btn())
    expect(onRerender).toHaveBeenCalledWith('Dial in your form and the strength follows')
    // The bug shipped on 09-23 would satisfy a naive "was called" assertion, so assert the
    // ORIGINAL is not what went out. This is the negative control.
    expect(onRerender).not.toHaveBeenCalledWith(reel.hook)
  })

  it('sends the original when the studio did NOT type — the unedited path stays intact', () => {
    const onRerender = vi.fn()
    render(<RerenderControl reel={reel} primary="#000" busy={false} onRerender={onRerender} />)
    fireEvent.click(btn())
    expect(onRerender).toHaveBeenCalledWith(reel.hook)
  })

  it('a re-render of a reel with no hook does not send undefined', () => {
    const onRerender = vi.fn()
    render(<RerenderControl reel={{ ...reel, hook: null }} primary="#000" busy={false} onRerender={onRerender} />)
    fireEvent.change(box(), { target: { value: 'A brand new hook' } })
    fireEvent.click(btn())
    expect(onRerender).toHaveBeenCalledWith('A brand new hook')
  })

  it('SURVIVES A BACKGROUND POLL: a re-render of the list must not wipe an unsent edit', () => {
    // The page polls every 15s while any reel is mid-flight and calls setReels with fresh
    // rows. That re-renders this control with a NEW reel object carrying the server's hook.
    // If the typed draft is dropped on that render, the studio's words vanish mid-sentence
    // and the next tap silently ships the original.
    const onRerender = vi.fn()
    const { rerender } = render(<RerenderControl reel={reel} primary="#000" busy={false} onRerender={onRerender} />)
    fireEvent.change(box(), { target: { value: 'Dial in your form and the strength follows' } })
    rerender(<RerenderControl reel={{ ...reel }} primary="#000" busy={false} onRerender={onRerender} />)
    expect(box().value).toBe('Dial in your form and the strength follows')
    fireEvent.click(btn())
    expect(onRerender).toHaveBeenCalledWith('Dial in your form and the strength follows')
  })

  it('at the cap the control is inert: box disabled, button disabled, no call', () => {
    const onRerender = vi.fn()
    render(<RerenderControl reel={{ ...reel, render_count: 3 }} primary="#000" busy={false} onRerender={onRerender} />)
    expect(box().disabled).toBe(true)
    expect(btn().disabled).toBe(true)
    fireEvent.click(btn())
    expect(onRerender).not.toHaveBeenCalled()
    expect(screen.getByText(/All 3 renders used/i)).toBeTruthy()
  })

  it('shows renders spent so the studio knows what it is spending', () => {
    render(<RerenderControl reel={reel} primary="#000" busy={false} onRerender={vi.fn()} />)
    expect(screen.getByText(/1 of 3 renders used/i)).toBeTruthy()
  })
})

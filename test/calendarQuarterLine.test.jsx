// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import React from 'react'
import { WeekView } from '../src/pages/Calendar.jsx'
import { quarterStartToShow } from '../src/lib/slotDate.js'

/**
 * C1, 2026-10-05: "Your quarter starts …" printed the start of the week ON SCREEN whenever that
 * week was in the future (week.starts_later), so paging forward made every week claim to be the
 * start of the quarter ("Week of December 28 / Your quarter starts December 28"). TLK's and the
 * test studio's quarter really starts 2026-10-01, a Thursday; the first planned week is Mon Oct 5.
 *
 * The fix shows the QUARTER's start, and only while today is before it. Negative control: the old
 * rule, verbatim, must fail the paging expectation below, or this file proves nothing.
 */
const oldLine = (week) => (week.starts_later ? week.week_start : null)

const QUARTER = { id: 'q1', quarter_start: '2026-10-01', quarter_end: '2026-12-31', status: 'draft', arc_text: '' }
const weekData = (week_start, starts_later) => ({
  empty: false, quarter: QUARTER, slots: [],
  week: { id: 'w-' + week_start, week_start, starts_later },
  prev_week_start: null, next_week_start: null,
})
const noop = () => {}
const lineFor = (data, today) => {
  cleanup()
  render(<WeekView data={data} primary="#bd8276" onNav={noop} onOpen={noop} today={today} />)
  const el = screen.queryByTestId('quarter-start')
  return el ? el.textContent : null
}

afterEach(() => cleanup())

describe('C1: the quarter-start line names the QUARTER, the same on every week', () => {
  it('before the quarter starts: every page shows the same line, the quarter_start', () => {
    const today = '2026-09-29' // Katie's 09-29 visit
    const pages = ['2026-10-05', '2026-10-12', '2026-12-28'].map((ws) => lineFor(weekData(ws, true), today))
    expect(pages).toEqual(['Your quarter starts October 1.', 'Your quarter starts October 1.', 'Your quarter starts October 1.'])
  })

  it('NEGATIVE CONTROL: the old rule changes with every page (it fails the expectation above)', () => {
    const pages = ['2026-10-05', '2026-10-12', '2026-12-28'].map((ws) => oldLine(weekData(ws, true).week))
    expect(new Set(pages).size).toBe(3) // three different "quarter starts" for one quarter
    expect(pages).not.toContain('2026-10-01')
  })

  it('once the quarter has started: no line on any week, even future ones (today 2026-10-05)', () => {
    for (const ws of ['2026-10-05', '2026-10-12', '2026-12-28']) {
      expect(lineFor(weekData(ws, ws > '2026-10-05'), '2026-10-05')).toBeNull()
    }
    // Control: the old rule still printed a line on every future week today.
    expect(oldLine(weekData('2026-12-28', true).week)).toBe('2026-12-28')
  })

  it('on the quarter start day itself: no line (it has started)', () => {
    expect(lineFor(weekData('2026-10-05', true), '2026-10-01')).toBeNull()
  })

  it('quarterStartToShow tolerates a missing quarter or date', () => {
    expect(quarterStartToShow(null, '2026-09-29')).toBeNull()
    expect(quarterStartToShow({ quarter_start: null }, '2026-09-29')).toBeNull()
    expect(quarterStartToShow(QUARTER, '')).toBeNull()
  })

  it('a malformed "today" (e.g. a locale-formatted 10/5/2026) shows NO line, never a line forever', () => {
    expect(quarterStartToShow(QUARTER, '09/29/2026')).toBeNull()
    expect(quarterStartToShow(QUARTER, '10/5/2026')).toBeNull()
    // Control: the unguarded comparison would have shown it ('1' < '2').
    expect('10/5/2026' < QUARTER.quarter_start).toBe(true)
  })

  it("the server's today (data.today) drives the header when no prop is given (device clock ignored)", () => {
    const before = { ...weekData('2026-10-12', true), today: '2026-09-29' }
    const after = { ...weekData('2026-10-12', true), today: '2026-10-05' }
    expect(lineFor(before, undefined)).toBe('Your quarter starts October 1.')
    expect(lineFor(after, undefined)).toBeNull()
  })
})

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { nextPlannedWeekToShow, planHasEnded } from '../src/lib/slotDate.js'

/**
 * Empty-weeks lines (Mac 2026-10-06; wording A1 and C1 approved, B keeps the current text).
 *
 * A: the server lands on the first week with slots that hasn't finished. When that week starts
 * after today, this week has nothing planned, and since C1 nothing said so: the owner opened the
 * app on Oct 6 and saw "Week of October 19" with no reason. The line is for THAT landing only;
 * a week the owner pages to is never called "next".
 * C: the plan has run out (viewed week finished and there is no later week).
 *
 * Measured 2026-10-06: TLK and Mac Test Studio v2 have 5 slots in every Q4 week, so nobody sees
 * A today; it appears with a gap week or a fully superseded week.
 */

vi.mock('../src/lib/supabase', () => ({ getSessionOnce: async () => ({ data: { session: { access_token: 't' } } }) }))
vi.mock('../src/context/AppContext', () => ({
  useApp: () => ({ studioLoaded: true, resolvedStudioId: 'studio-1', brandColorPrimary: '#bd8276', role: 'studio_owner', email: 'o@example.test', studioName: 'S', authReady: true }),
}))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ logout: async () => {} }) }))

const { WeekView, default: Calendar } = await import('../src/pages/Calendar.jsx')

const QUARTER = { id: 'q1', quarter_start: '2026-10-01', quarter_end: '2026-12-31', status: 'active', arc_text: '' }
const SLOT = { id: 's1', slot_date: '2026-10-21', job: 'connection', job_label: 'Connection', reason: 'r', status: 'planned' }
const data = (week_start, { prev = null, next = null, slots = [SLOT], today = '2026-10-06' } = {}) => ({
  empty: false, quarter: QUARTER, slots, today,
  week: { id: 'w-' + week_start, week_start, starts_later: week_start > today },
  prev_week_start: prev, next_week_start: next,
})
const A = 'Nothing is planned for this week. Your next planned week is October 19.'
const C = "Your planned weeks have ended. Your next quarter isn't planned yet."
const noop = () => {}
const lines = (d, landedWeek, today) => {
  cleanup()
  render(<WeekView data={d} primary="#bd8276" onNav={noop} onOpen={noop} today={today} landedWeek={landedWeek} />)
  return ['quarter-start', 'next-planned-week', 'plan-ended']
    .map((id) => screen.queryByTestId(id)).filter(Boolean).map((el) => el.textContent)
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('rules', () => {
  it('A: only the landed week, only when it starts after today', () => {
    expect(nextPlannedWeekToShow({ week_start: '2026-10-19' }, '2026-10-19', '2026-10-06')).toBe('2026-10-19')
    expect(nextPlannedWeekToShow({ week_start: '2026-10-05' }, '2026-10-05', '2026-10-06')).toBeNull() // this week has slots
    expect(nextPlannedWeekToShow({ week_start: '2026-10-05' }, '2026-10-05', '2026-10-05')).toBeNull() // Monday: it IS this week
    expect(nextPlannedWeekToShow({ week_start: '2026-10-26' }, '2026-10-19', '2026-10-06')).toBeNull() // paged to
    expect(nextPlannedWeekToShow({ week_start: '2026-10-19' }, null, '2026-10-06')).toBeNull()
    expect(nextPlannedWeekToShow({ week_start: '2026-10-19' }, '2026-10-19', '10/6/2026')).toBeNull() // bad date shows nothing
  })

  it('C: the last week, once it has finished (week end is exclusive)', () => {
    expect(planHasEnded({ week_start: '2026-12-28' }, null, '2027-01-04')).toBe(true)  // the day after it ends
    expect(planHasEnded({ week_start: '2026-12-28' }, null, '2027-01-03')).toBe(false) // its last day
    expect(planHasEnded({ week_start: '2026-12-28' }, '2027-01-04', '2027-01-20')).toBe(false) // a next quarter exists
    expect(planHasEnded({ week_start: '2026-12-28' }, null, 'Jan 4')).toBe(false)
  })
})

describe('WeekView lines', () => {
  it('A1: landing jumped past an empty current week -> the approved wording, once', () => {
    expect(lines(data('2026-10-19', { prev: '2026-10-12', next: '2026-10-26' }), '2026-10-19', '2026-10-06')).toEqual([A])
  })

  it('A is not shown on a week the owner paged to, even a future one', () => {
    expect(lines(data('2026-10-26', { prev: '2026-10-19', next: '2026-11-02' }), '2026-10-19', '2026-10-06')).toEqual([])
  })

  it('normal landing on the current week (it has slots): no line', () => {
    expect(lines(data('2026-10-05', { next: '2026-10-12' }), '2026-10-05', '2026-10-06')).toEqual([])
  })

  it('before the quarter starts: only "Your quarter starts", never stacked with A', () => {
    expect(lines(data('2026-10-05', { next: '2026-10-12', today: '2026-09-29' }), '2026-10-05', '2026-09-29'))
      .toEqual(['Your quarter starts October 1.'])
  })

  it('C1: last week has finished and nothing follows -> the approved wording', () => {
    expect(lines(data('2026-12-28', { prev: '2026-12-21', today: '2027-01-06' }), '2026-12-28', '2027-01-06')).toEqual([C])
  })

  it('A is not shown when the landed week has NO slots (server no-slots fallback to the first week row)', () => {
    expect(lines(data('2026-10-05', { next: '2026-10-12', slots: [], today: '2026-10-02' }), '2026-10-05', '2026-10-02')).toEqual([])
  })

  it('C is not shown on a finished week that has later (empty) weeks', () => {
    expect(lines(data('2026-12-21', { prev: '2026-12-14', next: '2026-12-28', today: '2027-01-06' }), null, '2027-01-06')).toEqual([])
  })

  it('C is not shown when a next quarter is planned (its weeks exist)', () => {
    expect(lines(data('2026-12-28', { prev: '2026-12-21', next: '2027-01-04', today: '2027-01-06' }), null, '2027-01-06')).toEqual([])
  })

  it('B unchanged: paging onto an empty week keeps the old text and adds no line', () => {
    cleanup()
    render(<WeekView data={data('2026-10-12', { prev: '2026-10-05', next: '2026-10-19', slots: [] })} primary="#bd8276" onNav={noop} onOpen={noop} today="2026-10-06" landedWeek="2026-10-19" />)
    expect(screen.getByText('Nothing planned this week')).toBeTruthy()
    expect(screen.getByText('Use the arrows to look at another week.')).toBeTruthy()
    expect(screen.queryByTestId('next-planned-week')).toBeNull()
  })
})

describe('Calendar page: the landed week is remembered through real loads', () => {
  it('shows A on the landing, hides it after paging forward, shows it again after paging back', async () => {
    const weeks = {
      landing: data('2026-10-19', { prev: '2026-10-12', next: '2026-10-26' }),
      '2026-10-26': data('2026-10-26', { prev: '2026-10-19', next: '2026-11-02' }),
      '2026-10-19': data('2026-10-19', { prev: '2026-10-12', next: '2026-10-26' }),
    }
    const asked = []
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
      const b = JSON.parse(opts.body)
      asked.push(b.week_start || null)
      return { ok: true, json: async () => (b.week_start ? weeks[b.week_start] : weeks.landing) }
    }))
    await act(async () => { render(<MemoryRouter><Calendar /></MemoryRouter>) })
    expect(asked).toEqual([null])
    expect(screen.getByTestId('next-planned-week').textContent).toBe(A)

    await act(async () => { fireEvent.click(screen.getByLabelText('Next week')) })
    expect(asked).toEqual([null, '2026-10-26'])
    expect(screen.queryByTestId('next-planned-week')).toBeNull()

    // Paging back to the landed week shows A again: the claim is about that week and is still true.
    await act(async () => { fireEvent.click(screen.getByLabelText('Previous week')) })
    expect(asked).toEqual([null, '2026-10-26', '2026-10-19'])
    expect(screen.getByTestId('next-planned-week').textContent).toBe(A)

    // A reload of that week (as after a slot action) asks for it by date and keeps the landing.
    await act(async () => { fireEvent.click(screen.getByLabelText('Next week')) })
    await act(async () => { fireEvent.click(screen.getByLabelText('Previous week')) })
    expect(asked.slice(-1)).toEqual(['2026-10-19'])
    expect(screen.getByTestId('next-planned-week').textContent).toBe(A)
  })

  it('once today reaches the landed week (server today rolls forward), A disappears on reload', async () => {
    const rolled = data('2026-10-19', { prev: '2026-10-12', next: '2026-10-26', today: '2026-10-19' })
    const asked = []
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
      const b = JSON.parse(opts.body); asked.push(b.week_start || null)
      return { ok: true, json: async () => (asked.length === 1 ? data('2026-10-19', { prev: '2026-10-12', next: '2026-10-26' }) : rolled) }
    }))
    await act(async () => { render(<MemoryRouter><Calendar /></MemoryRouter>) })
    expect(screen.getByTestId('next-planned-week')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByLabelText('Next week')) })
    expect(screen.queryByTestId('next-planned-week')).toBeNull()
  })
})

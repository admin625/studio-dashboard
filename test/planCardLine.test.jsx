// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import React from 'react'

/**
 * UX ruling 2b (Mac 2026-10-08): a plan card shows one plain line naming the goal, and "Why this
 * post?" leads to the full reasoning (the slot sheet). Seen on 10-08 at 390px: the card printed
 * the planner's paragraph ("…aligns with the quarter's 45% awareness weight…").
 */
vi.mock('../src/lib/supabase', () => ({ getSessionOnce: async () => ({ data: { session: { access_token: 't' } } }) }))
vi.mock('../src/context/AppContext', () => ({
  useApp: () => ({ studioLoaded: true, resolvedStudioId: 'studio-1', brandColorPrimary: '#bd8276', role: 'studio_owner', email: 'o@example.test', studioName: 'S', authReady: true }),
}))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ logout: async () => {} }) }))

const { WeekView } = await import('../src/pages/Calendar.jsx')

const PLANNER = "Saturday's early class-traffic post to own audience closes the week by fulfilling the second planned class-traffic slot."
const QUARTER = { id: 'q1', quarter_start: '2026-10-01', quarter_end: '2026-12-31', status: 'active', arc_text: '' }
const slot = (o) => ({ id: 's', slot_date: '2026-10-10', job: 'class_traffic', job_label: 'Into class', reason: PLANNER, reason_source: 'planner', status: 'planned', ...o })
const view = (slots) => render(
  <WeekView data={{ empty: false, quarter: QUARTER, slots, today: '2026-10-08', week: { id: 'w', week_start: '2026-10-05', starts_later: false }, prev_week_start: null, next_week_start: null }}
    primary="#bd8276" onNav={() => {}} onOpen={() => {}} today="2026-10-08" landedWeek="2026-10-05" />,
)
afterEach(cleanup)

describe('plan card line', () => {
  it("shows the plain goal, not the planner's paragraph, with a way to the full reason", () => {
    view([slot()])
    expect(screen.getByTestId('plan-line').textContent).toBe('Goal: get people booked into class.')
    expect(document.body.textContent).not.toContain('class-traffic slot')
    expect(screen.getByText(/Why this post\?/)).toBeTruthy()
  })

  it('her own words are shown as she wrote them', () => {
    view([slot({ reason: 'Bring a friend Saturday', reason_source: 'owner' })])
    expect(screen.getByTestId('plan-line').textContent).toBe('Bring a friend Saturday')
  })

  it('a held event slot names the event and offers no "Why this post?" (it does not open)', () => {
    view([slot({ job: 'event_conversion', job_label: 'Events', event_title: 'SHOP Fashion Show', held: true, status: 'held' })])
    expect(screen.getByTestId('plan-line').textContent).toBe('Goal: fill the room for SHOP Fashion Show.')
    expect(screen.queryByText(/Why this post\?/)).toBeNull()
  })
})

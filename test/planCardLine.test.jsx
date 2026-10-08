// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
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

})

describe('held event card (Mac 2026-10-08): "Why this post?" opens read-only', () => {
  it('closed by default; opens the full planner reasoning inline; nothing to edit; the card is not a button', () => {
    view([slot({ job: 'event_conversion', job_label: 'Events', event_title: 'SHOP Fashion Show', held: true, status: 'held' })])
    expect(screen.getByTestId('plan-line').textContent).toBe('Goal: fill the room for SHOP Fashion Show.')
    expect(screen.getByTestId('held-card').tagName).toBe('DIV')
    expect(screen.queryByTestId('held-why')).toBeNull()
    const t = screen.getByRole('button', { name: /why this post/i })
    expect(t.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(t)
    expect(screen.getByTestId('held-why').textContent).toBe(PLANNER)
    expect(t.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('textarea')).toBeNull()
    fireEvent.click(t)
    expect(screen.queryByTestId('held-why')).toBeNull()
  })

  it('negative control: an open card is still one button that opens the sheet, with no inline toggle', () => {
    let opened = null
    render(
      <WeekView data={{ empty: false, quarter: QUARTER, slots: [slot()], today: '2026-10-08', week: { id: 'w', week_start: '2026-10-05', starts_later: false }, prev_week_start: null, next_week_start: null }}
        primary="#bd8276" onNav={() => {}} onOpen={(x) => { opened = x }} today="2026-10-08" landedWeek="2026-10-05" />,
    )
    expect(screen.queryByTestId('held-card')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /why this post/i }))
    expect(opened && opened.id).toBe('s')
    expect(screen.queryByTestId('held-why')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { planLine } from '../src/lib/planLine.js'
import { waitLine, TAKING_LONGER_MS } from '../src/lib/waitLine.js'
import { humanizeType } from '../src/lib/postLabels.js'

/**
 * UX ruling 2b (Mac 2026-10-08). The plan card showed the planner's own reasoning ("…aligns with
 * the quarter's 45% awareness weight…"); it now shows one plain line naming the goal, and her own
 * words when she wrote the reason. Real planner text from Mac Test Studio v2 / TLK is the input.
 */
const PLANNER = "Opening the week on tuesday with an awareness post to own audience aligns with the quarter's 45% awareness weight and the plan's stated goal of helping people find their way into cycling, core, and barre-pilates as the season opens."

describe('planLine', () => {
  it('awareness: the goal in plain words, never the planner text', () => {
    const line = planLine({ job: 'awareness', reason: PLANNER, reason_source: 'planner', slot_date: '2026-10-05' })
    expect(line).toBe('Goal: help new people get to know you.')
    expect(line).not.toMatch(/weight|own audience|quarter/i)
  })
  it('class traffic claims no weekday (the post day is not proven to be the class day)', () => {
    expect(planLine({ job: 'class_traffic', slot_date: '2026-10-10' })).toBe('Goal: get people booked into class.')
  })
  it('events name the event; no title falls back', () => {
    expect(planLine({ job: 'event_conversion', event_title: 'SHOP Fashion Show' })).toBe('Goal: fill the room for SHOP Fashion Show.')
    expect(planLine({ job: 'event_conversion', event_title: '  ' })).toBe('Goal: fill the room for an upcoming event.')
  })
  it("her own words win, as she wrote them", () => {
    expect(planLine({ job: 'awareness', reason: ' Show off the new bikes ', reason_source: 'owner' })).toBe('Show off the new bikes')
  })
  it('negative control: an EMPTY owner reason does not blank the card', () => {
    expect(planLine({ job: 'awareness', reason: '   ', reason_source: 'owner' })).toBe('Goal: help new people get to know you.')
  })
  it('other jobs use their own label; nothing returns empty', () => {
    expect(planLine({ job: 'other', job_label: 'Instructor spotlight' })).toBe('Goal: Instructor spotlight.')
    expect(planLine({ job: 'other', job_label: 'Other' })).toBe('Goal: a post for your plan.')
    expect(planLine({ job: 'other', job_label: 'Retention push!! ' })).toBe('Goal: Retention push.')
    expect(planLine({ job: 'other', job_label: '...' })).toBe('Goal: a post for your plan.')
    expect(planLine(null)).toBe('')
  })
})

describe('waitLine: one estimate', () => {
  it('photos or unknown get the longer line; no photos the shorter', () => {
    expect(waitLine(false)).toBe('Usually takes about a minute.')
    expect(waitLine(true)).toBe('Usually a minute or two.')
    expect(waitLine()).toBe('Usually a minute or two.')
  })
  it('"taking longer" starts outside the promised range: the longest measured run (92 s, 10-08) plus a minute', () => {
    expect(TAKING_LONGER_MS).toBeGreaterThanOrEqual(92_000 + 60_000 - 2_000)
  })
  it('never promises a ceiling it cannot keep (the old "within 20 minutes")', () => {
    for (const v of [true, false, undefined]) expect(waitLine(v)).not.toMatch(/20|within/)
  })
})

describe('humanizeType', () => {
  it('raw codes read as words', () => {
    expect(humanizeType('CLASS_PROMO')).toBe('Class promo')
    expect(humanizeType('educational_tip')).toBe('Educational tip')
    expect(humanizeType('')).toBe('')
  })
})

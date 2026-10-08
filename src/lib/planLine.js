/**
 * The one plain line a plan card shows (UX ruling 2b, Mac 2026-10-08). Katie's requirement (co-design
 * 09-17): the "why" stays visible and names the digital objective. The planner's own rationale is
 * written for the planner ("…aligns with the quarter's 45% awareness weight…"), so on the card it
 * read as system-speak. That full text now lives behind "Why this post?" (the slot sheet), and the
 * card says the goal in plain words.
 *
 * Her own words win: a reason she wrote (reason_source 'owner') is shown as she wrote it.
 * Copy approved with 2b (pending at the 2b stop).
 */
export function planLine(slot) {
  if (!slot) return ''
  if (slot.reason_source === 'owner' && typeof slot.reason === 'string' && slot.reason.trim()) {
    return slot.reason.trim()
  }
  const title = typeof slot.event_title === 'string' ? slot.event_title.trim() : ''
  switch (slot.job) {
    case 'awareness':
      return 'Goal: help new people get to know you.'
    // No weekday: the post's day is not proven to be the class day it promotes (2b review).
    case 'class_traffic':
      return 'Goal: get people booked into class.'
    case 'event_conversion':
      return title ? `Goal: fill the room for ${title}.` : 'Goal: fill the room for an upcoming event.'
    default: {
      // job_label for 'other' is free text: strip its own end punctuation before adding ours.
      const label = typeof slot.job_label === 'string' ? slot.job_label.trim().replace(/[.!?]+$/, '') : ''
      return label && label !== 'Other' ? `Goal: ${label}.` : 'Goal: a post for your plan.'
    }
  }
}

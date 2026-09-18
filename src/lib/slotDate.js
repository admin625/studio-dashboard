/**
 * Formatting for `calendar_slots.slot_date`, in ONE place.
 *
 * 🚨 slot_date is a Postgres `date`, and `new Date('2026-10-05')` parses as
 * UTC-midnight. Formatting that in local time shows the PREVIOUS DAY anywhere west
 * of Greenwich — which is every studio we have. So the timeZone: 'UTC' is not a
 * nicety, it is the difference between Katie seeing Monday Oct 5 and seeing Sunday
 * Oct 4 for the same slot.
 *
 * This lived inside Calendar.jsx until 2026-09-18, when GenerateModal needed to show
 * the slot's date too. It moved here rather than being copied: a second, subtly
 * different date formatter is how two surfaces end up disagreeing about which day a
 * post is for, and neither of them errors.
 */

/** "Mon, Oct 5" — the slot's own day, never shifted by the viewer's timezone. */
export function fmtSlotDay(ymd) {
  if (!ymd) return ''
  return new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  })
}

/** "October 5" — used for week headings, where the weekday is noise. */
export function fmtSlotMonthDay(ymd) {
  if (!ymd) return ''
  return new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

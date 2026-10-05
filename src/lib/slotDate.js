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

/**
 * Which calendar day each post in a delivery was written for (HQ 2026-09-21: "make the date
 * visible so an owner can see it took"). Input: generation_posts rows for one delivery, with
 * the slot embedded — `{ platform, post_index, calendar_slots: { slot_date } }`.
 * Output: { 'instagram:0': '2026-10-05', ... }. Posts with no slot are absent, never guessed.
 * post_index is the 0-based position in content_deliveries.<platform>_content, the same index
 * DeliveryView renders by, so the key lines up by construction.
 */
export function slotDatesByPost(rows) {
  const out = {}
  for (const r of rows || []) {
    const d = r && r.calendar_slots && r.calendar_slots.slot_date
    if (d && r.platform != null && r.post_index != null) out[`${r.platform}:${r.post_index}`] = d
  }
  return out
}

/**
 * Today's date as YYYY-MM-DD in the viewer's (or a given) timezone. The calendar server used the
 * UTC date, so for a US studio every evening after 8pm EDT already counted as tomorrow (C2,
 * 2026-10-05). The app sends this instead; the server only accepts it within a day of UTC.
 */
export function localYmd(now = new Date(), timeZone = undefined) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/**
 * The quarter-start date to show in the week header, or null (C1, 2026-10-05). It is the
 * QUARTER's start, shown only while today is before it. The old line printed the start of
 * whichever week was on screen, so every future week claimed to be the start of the quarter.
 */
export function quarterStartToShow(quarter, today) {
  const qs = quarter && quarter.quarter_start
  if (!qs || !today) return null
  return today < qs ? qs : null
}

/** "October 5" — used for week headings, where the weekday is noise. */
export function fmtSlotMonthDay(ymd) {
  if (!ymd) return ''
  return new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

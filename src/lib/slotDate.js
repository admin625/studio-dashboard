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

/** "Saturday" — the slot's own weekday, by the same UTC rule. '' for a missing or bad date. */
export function slotWeekday(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ''
  const d = new Date(ymd + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
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
  // Built from parts, not from a locale's formatted string: no browser's locale data can turn this
  // into "10/5/2026", which would break the string comparison in quarterStartToShow.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t) => (parts.find((p) => p.type === t) || {}).value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * The quarter-start date to show in the week header, or null (C1, 2026-10-05). It is the
 * QUARTER's start, shown only while today is before it. The old line printed the start of
 * whichever week was on screen, so every future week claimed to be the start of the quarter.
 */
export function quarterStartToShow(quarter, today) {
  const qs = quarter && quarter.quarter_start
  // A string comparison of dates is only valid for YYYY-MM-DD on both sides: "10/5/2026" < "2026-…"
  // would be true forever and bring the C1 bug back in a new form. Anything else shows no line.
  const ymd = /^\d{4}-\d{2}-\d{2}$/
  if (!qs || !ymd.test(String(qs)) || !ymd.test(String(today || ''))) return null
  return today < qs ? qs : null
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD plus n days, in UTC (dates here are calendar days, never instants). */
function addDaysYmd(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Empty-weeks line A (Mac 2026-10-06): the week to name in "Your next planned week is …", or null.
 * Only on the week the app LANDED on by itself, and only when that week starts after today: the
 * server lands on the first week with slots that hasn't finished, so a landing that starts after
 * today means this week has nothing planned. A week the owner paged to is never "next" by this
 * rule (paging forward to any future week would otherwise claim it). Callers hide it while the
 * "Your quarter starts …" line shows, so the two never stack, and when the week has no slots
 * (the server's no-slots fallback lands on the first week row).
 */
export function nextPlannedWeekToShow(week, landedWeekStart, today) {
  const ws = week && week.week_start
  if (!ws || !YMD.test(String(ws)) || !YMD.test(String(today || ''))) return null
  if (ws !== landedWeekStart) return null
  return ws > today ? ws : null
}

/**
 * Empty-weeks line C (Mac 2026-10-06): true when the plan has run out. The viewed week has
 * finished AND it is the studio's last week (no next week at all). A planned next quarter has
 * weeks of its own, so it gives this week a next_week_start and the line can't claim "not
 * planned" wrongly. App-only, so one case is missed by design: a landing on the last week WITH
 * slots when empty weeks follow it shows no line (the owner sees it on reaching the last week).
 */
export function planHasEnded(week, nextWeekStart, today) {
  const ws = week && week.week_start
  if (!ws || !YMD.test(String(ws)) || !YMD.test(String(today || ''))) return false
  if (nextWeekStart) return false
  return addDaysYmd(ws, 7) <= today
}

/** "October 5" — used for week headings, where the weekday is noise. */
export function fmtSlotMonthDay(ymd) {
  if (!ymd) return ''
  return new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

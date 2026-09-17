/**
 * calendar — owner-facing content calendar (2d first cut: week view, slot view, quarter view).
 *
 * WHY A FUNCTION AND NOT A DIRECT BROWSER READ
 * --------------------------------------------
 * The calendar tables ARE readable by `authenticated` under owner-scoped RLS, so a direct read
 * would work. This function exists for the WRITE side and keeps reads on the same path so the
 * two cannot drift apart: every owner write in this cut (reason edit, accept, skip,
 * generate_requested) must carry source + actor, and `actor` has to be the caller's verified
 * email — not a value the browser hands us. A client-supplied actor is not provenance.
 *
 * It holds service_role, so per _authz.cjs it re-inherits the RLS bypass and must hand-roll
 * tenancy. It does, on EVERY action, via requireStudioAccess(..., 'owner').
 *
 * LEVEL IS 'owner', DELIBERATELY. The WO scopes this cut to the owner surface. Instructors are
 * members, not owners, and `owned_studio_ids()` — the function the table policies key on —
 * matches studio_accounts.owner_email. Passing 'member' here would admit instructors that the
 * table's own RLS would then deny, which is a confusing failure rather than a safe one.
 *
 * WHAT THIS CUT DOES NOT DO: mix sliders, re-point a week, event cadence, event date entry,
 * instructor seats, planner re-run. Out of scope by the WO; do not add them here quietly.
 */
const { requireStudioAccess } = require('./_authz.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fidhmvuurygpknhshpml.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JOBS = ['awareness', 'class_traffic', 'event_conversion'];

function rest(path, init) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...(init || {}),
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...((init && init.headers) || {}),
    },
  });
}

async function getJson(path) {
  const r = await rest(path);
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

/** YYYY-MM-DD in UTC. Slot dates are `date` columns, so never involve a local timezone. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Katie's words, not the database's. The DB vocabulary is a lookup table (calendar_jobs) and
 * stays canonical; this is display only. `other` falls back to the slot's own job_other text,
 * which the CHECK guarantees is present exactly when job='other'.
 */
function jobLabel(job, jobOther) {
  if (job === 'awareness') return 'Getting to know us';
  if (job === 'class_traffic') return 'Into class';
  if (job === 'event_conversion') return 'Events';
  return jobOther || 'Other';
}

/**
 * The displayed reason: the latest owner rationale if one exists, else the planner's column.
 * The planner's `calendar_slots.rationale` is NEVER mutated — that is the whole point of the
 * separate table. `source` is fixed to 'owner' by a CHECK, so any row here is an owner row.
 */
function resolveReason(slot, ownerRationales) {
  const mine = (ownerRationales || [])
    .filter((r) => r.slot_id === slot.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (mine.length) {
    return { reason: mine[0].rationale, reason_source: 'owner', reason_edited_at: mine[0].created_at };
  }
  return { reason: slot.rationale, reason_source: 'planner', reason_edited_at: null };
}

function percentages(slots) {
  const live = slots.filter((s) => s.status !== 'superseded');
  const total = live.length;
  const out = {};
  for (const j of JOBS) {
    const n = live.filter((s) => s.job === j).length;
    // Percentages are computed from the SLOTS the owner can actually see, not from
    // calendar_weeks.planned_jobs. The jsonb is the planner's intent and can drift from the
    // rows; if it did, the quarter bars would contradict the week list on the next screen.
    out[j] = total ? Math.round((n / total) * 100) : 0;
  }
  return { total, pct: out };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  if (!SERVICE_KEY) return respond(500, { error: 'Calendar is not configured.' });

  let body;
  try { body = JSON.parse(event.body); } catch { return respond(400, { error: 'Invalid JSON' }); }

  const studioId = body && body.studio_id;
  const action = body && body.action;

  const gate = await requireStudioAccess(event, studioId, 'owner');
  if (!gate.ok) return respond(gate.status, { error: gate.error });

  try {
    if (action === 'week') return await week(studioId, body.week_start);
    if (action === 'quarter') return await quarter(studioId);
    if (action === 'act') return await act(studioId, body, gate.email);
    if (action === 'reason') return await reason(studioId, body, gate.email);
    return respond(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('[calendar] ' + action + ' failed:', err.message);
    return respond(502, { error: 'Calendar request failed.' });
  }
};

/**
 * WEEK — the current week, or the first week carrying slots on or after today.
 *
 * HQ ruling 2026-09-17: the view lands on the first week with slots >= today and says so in a
 * header, rather than re-dating anything. TLK's Q4 starts 2026-10-05, so before October this
 * legitimately lands ahead of "now" — an empty current week is the true state of the plan, and
 * showing the next real week beats showing nothing.
 */
async function week(studioId, weekStart) {
  const weeks = await getJson(
    'calendar_weeks?studio_id=eq.' + enc(studioId) + '&select=id,week_start,quarter_id&order=week_start.asc'
  );
  if (!weeks || !weeks.length) return respond(200, { empty: true, reason: 'no_quarter' });

  const t = today();
  const slotDates = await getJson(
    'calendar_slots?studio_id=eq.' + enc(studioId) +
    '&status=neq.superseded&select=week_id,slot_date&order=slot_date.asc'
  ) || [];

  const weeksWithSlots = new Set(slotDates.map((s) => s.week_id));
  const upcoming = weeks.filter((w) => weeksWithSlots.has(w.id));

  let target = null;
  if (weekStart) target = weeks.find((w) => w.week_start === weekStart) || null;
  if (!target) {
    target = upcoming.find((w) => {
      const end = addDays(w.week_start, 7);
      return end > t; // the week has not finished yet
    }) || upcoming[upcoming.length - 1] || weeks[0];
  }

  const idx = weeks.findIndex((w) => w.id === target.id);
  const slots = await slotsForWeek(studioId, target.id);
  const quarterRow = (await getJson(
    'calendar_quarters?id=eq.' + enc(target.quarter_id) + '&select=id,quarter_start,quarter_end,status,arc_text'
  ) || [])[0] || null;

  // Is the landed week in the future relative to today? Drives the header copy.
  const startsLater = target.week_start > t;

  return respond(200, {
    empty: false,
    week: { id: target.id, week_start: target.week_start, starts_later: startsLater },
    quarter: quarterRow,
    prev_week_start: idx > 0 ? weeks[idx - 1].week_start : null,
    next_week_start: idx >= 0 && idx < weeks.length - 1 ? weeks[idx + 1].week_start : null,
    slots,
  });
}

async function slotsForWeek(studioId, weekId) {
  const slots = await getJson(
    'calendar_slots?studio_id=eq.' + enc(studioId) + '&week_id=eq.' + enc(weekId) +
    '&status=neq.superseded&select=id,slot_date,soft_slot,job,job_other,audience,status,rationale,program_entry_id,program_entries(title,manual_hold,hold_reason,confirmation_status)&order=slot_date.asc'
  ) || [];
  if (!slots.length) return [];

  const ids = slots.map((s) => s.id);
  const inList = '(' + ids.map(enc).join(',') + ')';
  const [rationales, actions, posts] = await Promise.all([
    getJson('calendar_slot_rationales?slot_id=in.' + inList + '&select=slot_id,rationale,created_at&order=created_at.desc'),
    getJson('calendar_slot_actions?slot_id=in.' + inList + '&select=slot_id,action,created_at&order=created_at.desc'),
    getJson('generation_posts?slot_id=in.' + inList + '&select=id,slot_id,created_at&order=created_at.desc'),
  ]);

  return slots.map((s) => {
    const acts = (actions || []).filter((a) => a.slot_id === s.id);
    const post = (posts || []).find((p) => p.slot_id === s.id) || null;
    const pe = s.program_entries || null;
    return {
      id: s.id,
      slot_date: s.slot_date,
      soft_slot: s.soft_slot,
      job: s.job,
      job_label: jobLabel(s.job, s.job_other),
      audience: s.audience,
      status: s.status,
      held: s.status === 'held',
      hold_reason: pe && pe.manual_hold ? pe.hold_reason : null,
      event_title: pe ? pe.title : null,
      ...resolveReason(s, rationales),
      accepted: acts.some((a) => a.action === 'accepted'),
      skipped: acts.some((a) => a.action === 'skipped'),
      post_id: post ? post.id : null,
    };
  });
}

/** QUARTER — read-only. 13 weeks, three percentages per week, event name where one exists. */
async function quarter(studioId) {
  const q = (await getJson(
    'calendar_quarters?studio_id=eq.' + enc(studioId) +
    '&select=id,quarter_start,quarter_end,status,arc_text&order=quarter_start.desc&limit=1'
  ) || [])[0];
  if (!q) return respond(200, { empty: true, reason: 'no_quarter' });

  const weeks = await getJson(
    'calendar_weeks?quarter_id=eq.' + enc(q.id) + '&select=id,week_start&order=week_start.asc'
  ) || [];
  const slots = await getJson(
    'calendar_slots?quarter_id=eq.' + enc(q.id) +
    '&status=neq.superseded&select=id,week_id,job,status,program_entry_id,program_entries(title)'
  ) || [];

  const rows = weeks.map((w) => {
    const mine = slots.filter((s) => s.week_id === w.id);
    const { total, pct } = percentages(mine);
    const ev = mine.map((s) => s.program_entries && s.program_entries.title).filter(Boolean);
    return {
      week_start: w.week_start,
      planned: total,
      pct,
      held: mine.filter((s) => s.status === 'held').length,
      event_title: ev.length ? ev[0] : null,
    };
  });

  return respond(200, { empty: false, quarter: q, weeks: rows });
}

/**
 * ACT — append an owner action. Append-only by grant and by policy: `authenticated` holds
 * SELECT+INSERT and nothing else, so there is no update path to misuse.
 */
async function act(studioId, body, actorEmail) {
  const allowed = ['accepted', 'skipped', 'generate_requested'];
  if (!allowed.includes(body.value)) return respond(400, { error: 'Unknown action value' });
  const slot = await ownedSlot(studioId, body.slot_id);
  if (!slot) return respond(404, { error: 'No such slot for this studio.' });

  const r = await rest('calendar_slot_actions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      slot_id: body.slot_id,
      action: body.value,
      source: 'owner',
      actor: actorEmail,
    }),
  });
  if (!r.ok) {
    console.error('[calendar] action insert failed', r.status);
    return respond(502, { error: 'Could not record that.' });
  }
  const rows = await r.json().catch(() => []);
  return respond(200, { ok: true, row: rows && rows[0] ? rows[0] : null });
}

/** REASON — append an owner rationale. The planner's column is never written. */
async function reason(studioId, body, actorEmail) {
  const text = String(body.rationale || '').trim();
  if (!text) return respond(400, { error: 'A reason is required.' });
  if (text.length > 2000) return respond(400, { error: 'That reason is too long.' });
  const slot = await ownedSlot(studioId, body.slot_id);
  if (!slot) return respond(404, { error: 'No such slot for this studio.' });

  const r = await rest('calendar_slot_rationales', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      slot_id: body.slot_id,
      rationale: text,
      source: 'owner',
      actor: actorEmail,
    }),
  });
  if (!r.ok) {
    console.error('[calendar] rationale insert failed', r.status);
    return respond(502, { error: 'Could not save that reason.' });
  }
  const rows = await r.json().catch(() => []);
  return respond(200, { ok: true, row: rows && rows[0] ? rows[0] : null });
}

/**
 * The slot must belong to the studio the caller was gated on. requireStudioAccess proved the
 * caller owns `studioId`; it says nothing about whether this slot_id does. Without this check a
 * caller could write an action onto another studio's slot through their own gate.
 */
async function ownedSlot(studioId, slotId) {
  if (!slotId) return null;
  const rows = await getJson(
    'calendar_slots?id=eq.' + enc(slotId) + '&studio_id=eq.' + enc(studioId) + '&select=id,status&limit=1'
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function enc(v) { return encodeURIComponent(String(v)); }

function cors() {
  return {
    'Access-Control-Allow-Origin': process.env.DASHBOARD_ORIGIN || 'https://app.fiorsaoirse.com',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function respond(status, body) {
  return {
    statusCode: status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

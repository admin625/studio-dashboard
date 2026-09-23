/**
 * reels — service-role access to reel_edls for studio-dash Reel Editor (D2 review + delivery).
 *
 * WHY THIS EXISTS: public.reel_edls is RLS deny-by-default (service_role bypasses).
 * The browser's anon key cannot read render_status/render_url nor set status='approved',
 * so all reel access is routed through this server-side function which holds the
 * service-role key + the WF2 webhook secret in Netlify env (never shipped to the client).
 *
 * Actions (POST body { action, ... }):
 *   list        { studio_id }            -> the studio's reels + render fields (trimmed edl: hook/clip_count/duration).
 *                                           Delivered reels' render_url is signed here (short-TTL); the compact row
 *                                           defers the <video> MOUNT to expand, so no video bytes are fetched while
 *                                           collapsed. (Signing at list keeps the response backward-compatible with any
 *                                           cached client — the server fn is always current — and avoids an async
 *                                           expand-sign path that broke playback for stale frontends.)
 *   sign_render { reel_id }              -> mint a short-TTL signed playback URL for a delivered reel (kept for
 *                                           on-demand use; the UI now reads the list-signed render_url directly).
 *   approve     { reel_id, hook_text? }  -> capture the reviewer's final hook into the EDL (overlays[0].text +
 *                                           approval.hook_edited) as the moat signal BEFORE render, flip
 *                                           pending_approval->approved (conditional), then fire the authenticated
 *                                           WF2 render webhook (x-wf2-secret). Renders nothing without the header.
 *   rerender    { reel_id, hook_text? }  -> render an ALREADY approved reel again, capped at MAX_RENDERS total.
 *                                           Only from a terminal render state (delivered or a failure), never
 *                                           mid-flight. An edited hook keeps the ORIGINAL proposal in
 *                                           overlays[0].proposed_text so WF2's capture records hook_edited=true.
 *
 * WHERE THE CAP ACTUALLY LIVES: in WF2, as claim_render_slot() — one atomic UPDATE that returns no row at
 * the cap. The check in rerenderGuard() below is only fast feedback for the UI; it is NOT the gate, because
 * anything holding the WF2 secret could call the webhook directly. Never move the cap here.
 *
 * Track B: source clips (reel-sources) + renders (reel-renders) are private, studio-scoped. Fetchable URLs are
 * minted at use (WF1 sign-to-probe, WF2 sign-at-render, and here sign-at-load) — never baked into the DB.
 */
const { requireStudioAccess } = require('./_authz.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fidhmvuurygpknhshpml.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WF2_URL = process.env.WF2_WEBHOOK_URL || 'https://jmac.app.n8n.cloud/webhook/wf2-render';

// Renders allowed per reel, total (first render + re-renders). Mirrors p_max in WF2's claim_render_slot
// call; WF2 is the enforcing side. Changing this alone changes only the UI's fast feedback.
const MAX_RENDERS = 3;
// A re-render is only sensible once the previous one has stopped moving.
const RERENDERABLE = ['delivered', 'render_failed', 'render_timeout', 'delivery_failed'];

/** Fast feedback before firing WF2. WF2's atomic claim is the real cap. */
function rerenderGuard(row, max = MAX_RENDERS) {
  if (!row) return { status: 404, error: 'Reel not found' };
  if (row.status !== 'approved') return { status: 409, error: 'This reel has not been generated yet. Use Generate Reel first.' };
  if (!RERENDERABLE.includes(row.render_status)) return { status: 409, error: 'This reel is still rendering. Wait for it to finish, then render again.' };
  if ((row.render_count || 0) >= max) {
    return { status: 409, code: 'render_cap_reached', error: 'This reel has been rendered ' + max + ' times. Start a new reel to keep going.' };
  }
  return { ok: true };
}

/**
 * Fold a re-render's hook into the EDL. proposed_text must keep the ORIGINAL proposal: reel_hook_captures
 * derives hook_edited as (final_text IS DISTINCT FROM proposed_text) in a GENERATED column, so overwriting
 * the proposal with the edit would record every edit as "not edited" — the exact reason 0 of 27 historical
 * captures show an edit.
 *
 * hook_edited is therefore "differs from WF1's ORIGINAL proposal", not "was edited on THIS render". A
 * re-render with no change still records true if the hook was edited at approve time. Reading it as
 * per-render is how a negative control gets misjudged — an unedited re-render proves nothing unless the
 * reel's hook was never edited at all.
 */
function foldHookIntoEdl(edl, hookText) {
  const next = Object.assign({}, edl || {});
  const overlays = Array.isArray(next.overlays) ? next.overlays.map((o) => Object.assign({}, o)) : [];
  const o = overlays[0];
  let hook_edited = !!(next.approval && next.approval.hook_edited);
  let changed = false;
  if (o && typeof hookText === 'string' && hookText.trim()) {
    if (o.proposed_text == null) o.proposed_text = o.text; // first edit: today's text IS the proposal
    const finalText = hookText.trim();
    changed = finalText !== o.text;
    o.text = finalText;
    hook_edited = o.text !== o.proposed_text;
  }
  next.overlays = overlays;
  next.approval = Object.assign({}, next.approval, { hook_edited });
  return { edl: next, hook_edited, changed };
}
const WF2_SECRET = process.env.WF2_WEBHOOK_SECRET;
const RENDER_URL_TTL_S = 21600; // 6h — comfortable review window; re-minted on each list.

// Studio display name for the download filename. Never throws and never blocks the response:
// a null name degrades the filename, it does not degrade the download.
async function studioNameFor(rest, studioId) {
  if (!studioId) return null;
  try {
    const r = await rest('studio_accounts?id=eq.' + encodeURIComponent(studioId) + '&select=studio_name&limit=1');
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0].studio_name : null;
  } catch { return null; }
}

// A filename the owner will recognise in her camera roll: "the-local-kollective-reel-2026-08-06.mp4".
// Without this the browser names the file after the storage object, which is a bare UUID.
function downloadFilename(studioName, createdAt) {
  const slug = String(studioName || 'studio')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip accents so the slug stays ASCII
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'studio';
  // Check createdAt is truthy BEFORE constructing: new Date(null) is epoch 0, which is a
  // perfectly valid date, so an isNaN guard alone silently ships "1970-01-01" as the filename.
  const d = createdAt ? new Date(createdAt) : null;
  const day = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : 'undated';
  return `${slug}-reel-${day}.mp4`;
}

// Delivered reels hold a reel-renders storage path in render_url. Mint a signed URL for playback.
// Back-compat: a full http(s) URL (older rows) passes through unchanged; null/empty stays null.
//
// `filename` makes storage return Content-Disposition: attachment. That is load-bearing, not
// cosmetic: the browser's `download` attribute on an <a> is IGNORED cross-origin, and these
// signed URLs are on supabase.co while the app is on netlify.app. So the attribute has never
// worked on any platform — desktop only appeared to because the browser's built-in video viewer
// offered its own save. On phone there is no such viewer affordance, so the reel just played.
// Verified against the live endpoint, not assumed: without the param there is no
// Content-Disposition header at all; with it, storage returns `attachment; filename=...`.
async function signRenderUrl(val, filename) {
  if (!val || /^https?:\/\//i.test(val)) return val || null;
  try {
    const res = await fetch(SUPABASE_URL + '/storage/v1/object/sign/reel-renders/' + val, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: RENDER_URL_TTL_S }),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({}));
    const signed = j.signedURL || j.signedUrl;
    if (!signed) return null;
    const url = SUPABASE_URL + '/storage/v1' + signed;
    if (!filename) return url;
    // The signed URL already carries ?token=..., so the download param joins with &.
    return url + (url.includes('?') ? '&' : '?') + 'download=' + encodeURIComponent(filename);
  } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  if (!SERVICE_KEY) return respond(500, { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured. Set it in Netlify environment variables.' });

  // Require a valid Supabase session (authenticated user).
  const authz = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authz.replace(/^Bearer\s+/i, '').trim();
  if (!token) return respond(401, { error: 'Missing auth token' });
  const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
  });
  if (!userRes.ok) return respond(401, { error: 'Invalid or expired session' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return respond(400, { error: 'Invalid JSON' }); }

  const rest = (path, opts = {}) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });

  try {
    if (body.action === 'list') {
      // studio_id arrives from the caller. A valid session is NOT evidence it is their studio.
      const gate = await requireStudioAccess(event, body.studio_id, 'member');
      if (!gate.ok) return respond(gate.status, { error: gate.error });
      const r = await rest('reel_edls?studio_id=eq.' + encodeURIComponent(body.studio_id) +
        '&select=reel_id,studio_id,status,edl,render_status,render_url,render_id,render_submitted_at,render_count,created_at,updated_at&order=created_at.desc');
      const rows = await r.json();
      if (!Array.isArray(rows)) return respond(502, { error: 'reel_edls read failed', detail: rows });
      // One lookup for the whole page: every row here shares body.studio_id. Failure is
      // non-fatal — downloadFilename falls back to "studio-reel-<date>.mp4".
      const studioName = await studioNameFor(rest, body.studio_id);
      const reels = await Promise.all(rows.map(async (x) => ({
        reel_id: x.reel_id,
        studio_id: x.studio_id,
        status: x.status,
        render_status: x.render_status,
        render_url: await signRenderUrl(x.render_url, downloadFilename(studioName, x.created_at)),
        render_ready: x.render_status === 'delivered' && !!x.render_url,
        render_count: x.render_count || 0,
        renders_left: Math.max(0, MAX_RENDERS - (x.render_count || 0)),
        created_at: x.created_at,
        updated_at: x.updated_at,
        hook: x.edl && x.edl.overlays && x.edl.overlays[0] ? x.edl.overlays[0].text : null,
        clip_count: x.edl && Array.isArray(x.edl.timeline) ? x.edl.timeline.length : null,
        duration_s: x.edl && x.edl.output ? x.edl.output.target_duration_s : null,
        // validation carries checks + flags. The UI needs it to say WHY an assembly failed:
        // without it every validation_failed reel got one generic string, and that string
        // advised "a shorter target length" — which is what CAUSES avoidable_clip_reuse.
        // Flags embed payloads that came from the model or the vendor
        // (opus_call_error:<Anthropic message>, inout_oob:<clip_id>, timeline_gap@seq3).
        // The UI only prefix-matches to select hardcoded copy, so ship the KIND, not the
        // payload — no model- or vendor-authored string crosses to the browser.
        validation: x.edl && x.edl.validation ? {
          checks: x.edl.validation.checks || null,
          flags: Array.isArray(x.edl.validation.flags)
            ? x.edl.validation.flags.map((f) => String(f).split(/[:@]/)[0])
            : [],
        } : null,
      })));
      return respond(200, { reels });
    }

    if (body.action === 'sign_render') {
      if (!body.reel_id) return respond(400, { error: 'reel_id is required' });
      const r = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) + '&select=render_url,render_status,studio_id,created_at&limit=1');
      const rows = await r.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return respond(404, { error: 'Reel not found' });
      // Gate on the studio the REEL belongs to, not one the caller names.
      const gate = await requireStudioAccess(event, row.studio_id, 'member');
      if (!gate.ok) return respond(gate.status, { error: gate.error });
      const studioName = await studioNameFor(rest, row.studio_id);
      const url = await signRenderUrl(row.render_url, downloadFilename(studioName, row.created_at));
      return respond(200, { render_url: url });
    }

    if (body.action === 'approve') {
      if (!body.reel_id) return respond(400, { error: 'reel_id is required' });
      if (!WF2_SECRET) return respond(500, { error: 'WF2_WEBHOOK_SECRET is not configured. Set it in Netlify environment variables.' });

      // Authorize BEFORE the state check, so a non-member cannot use the 409-vs-403 difference
      // to learn whether another studio's reel exists or what state it is in.
      const own = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) + '&select=studio_id&limit=1');
      const ownRows = await own.json();
      const ownRow = Array.isArray(ownRows) ? ownRows[0] : null;
      if (!ownRow) return respond(404, { error: 'Reel not found' });
      // 'member', not 'owner': approve IS the generate step, and the agreed scope gives
      // instructors view + generate + edit for their own studio. It does spend money on a
      // render, so if that should be owner-only this is the single word to change.
      const gate = await requireStudioAccess(event, ownRow.studio_id, 'member');
      if (!gate.ok) return respond(gate.status, { error: gate.error });

      // Fetch the pending EDL so we can fold the reviewer's final hook in as the moat signal.
      const cur = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) + '&status=eq.pending_approval&select=edl&limit=1');
      const curRows = await cur.json();
      const curRow = Array.isArray(curRows) ? curRows[0] : null;
      if (!curRow) return respond(409, { error: 'Reel is not in pending_approval state (already approved, rendering, or not found).' });

      const edl = curRow.edl || {};
      const overlays = Array.isArray(edl.overlays) ? edl.overlays : [];
      let hook_edited = !!(edl.approval && edl.approval.hook_edited);
      if (typeof body.hook_text === 'string' && overlays[0]) {
        const proposed = overlays[0].proposed_text != null ? overlays[0].proposed_text : overlays[0].text;
        const finalText = body.hook_text.trim();
        if (finalText) overlays[0].text = finalText;
        hook_edited = overlays[0].text !== proposed; // moat signal: did the studio change the wording?
      }
      edl.overlays = overlays;
      edl.approval = Object.assign({}, edl.approval, { hook_edited, approved_at: new Date().toISOString() });

      // Conditional flip + EDL update. If the row isn't still pending, 0 rows -> we do NOT fire (prevents
      // double-render / re-approve spend). WF2's Capture Insert records proposed vs final before the render.
      const patch = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) + '&status=eq.pending_approval', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'approved', edl }),
      });
      const updated = await patch.json();
      if (!Array.isArray(updated) || updated.length === 0) {
        return respond(409, { error: 'Reel is not in pending_approval state (already approved, rendering, or not found).' });
      }
      // Fire the authenticated WF2 render webhook. Secret lives only here (server-side).
      const wh = await fetch(WF2_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wf2-secret': WF2_SECRET },
        body: JSON.stringify({ reel_id: body.reel_id }),
      });
      const text = await wh.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return respond(200, { approved: true, reel_id: body.reel_id, hook_edited, webhook_status: wh.status, webhook: data });
    }

    if (body.action === 'rerender') {
      if (!body.reel_id) return respond(400, { error: 'reel_id is required' });
      if (!WF2_SECRET) return respond(500, { error: 'WF2_WEBHOOK_SECRET is not configured. Set it in Netlify environment variables.' });

      // Authorize BEFORE the state check, exactly as approve does: a non-member must not learn from a
      // 409-vs-403 whether another studio's reel exists or how many renders it has used.
      const own = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) + '&select=studio_id&limit=1');
      const ownRows = await own.json();
      const ownRow = Array.isArray(ownRows) ? ownRows[0] : null;
      if (!ownRow) return respond(404, { error: 'Reel not found' });
      const gate = await requireStudioAccess(event, ownRow.studio_id, 'member');
      if (!gate.ok) return respond(gate.status, { error: gate.error });

      const cur = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) +
        '&select=status,render_status,render_count,edl&limit=1');
      const curRows = await cur.json();
      const row = Array.isArray(curRows) ? curRows[0] : null;
      const guard = rerenderGuard(row);
      if (!guard.ok) return respond(guard.status, guard.code ? { error: guard.error, code: guard.code } : { error: guard.error });

      const folded = foldHookIntoEdl(row.edl, body.hook_text);
      if (folded.changed) {
        // Only the EDL moves. status stays 'approved' and render_count is WF2's to increment.
        const patch = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) + '&status=eq.approved', {
          method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ edl: folded.edl }),
        });
        const updated = await patch.json();
        if (!Array.isArray(updated) || updated.length === 0) {
          return respond(409, { error: 'This reel is no longer in a state we can re-render.' });
        }
      }

      const wh = await fetch(WF2_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wf2-secret': WF2_SECRET },
        body: JSON.stringify({ reel_id: body.reel_id }),
      });
      const text = await wh.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      // WF2 owns the cap: a refusal comes back 200 with refused:true, so surface it as a 409 to the UI.
      if (data && data.refused) {
        return respond(409, { error: data.message || 'This reel cannot be rendered again.', code: data.code || 'render_refused', reel_id: body.reel_id });
      }
      return respond(200, { rerendered: true, reel_id: body.reel_id, hook_edited: folded.hook_edited, webhook_status: wh.status, webhook: data });
    }

    return respond(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('[reels] error:', err.message);
    return respond(502, { error: 'Reels function error', detail: err.message });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': process.env.DASHBOARD_ORIGIN || 'https://studio-dash.netlify.app',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}
function respond(status, body) {
  return { statusCode: status, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

module.exports.rerenderGuard = rerenderGuard;
module.exports.foldHookIntoEdl = foldHookIntoEdl;
module.exports.MAX_RENDERS = MAX_RENDERS;

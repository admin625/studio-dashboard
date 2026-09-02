/**
 * reel-create-background — B2 STEP 3: fire WF1 (Edit Planner) for a new self-serve reel.
 *
 * A Netlify BACKGROUND function (name ends in -background): returns 202 immediately and runs up to
 * 15 min, so it can wait on WF1's slow chain (sign -> probe -> Opus -> validate -> persist) without a
 * sync-function timeout. WF1 persists a pending_approval reel_edls row; the Reels list poll surfaces it.
 *
 * Holds WF1_WEBHOOK_SECRET server-side (never shipped to the client). Authz (defense in depth — the
 * reel-sources upload RLS is the primary, client-visible gate): the caller's session must be a member
 * of manifest.studio_id (parity with get_my_studio_ids = active instructor OR client), and every clip
 * path must live under {studio_id}/, so a client cannot make WF1 sign another studio's clips.
 *
 * Does NOT touch WF2 / approve / render — that stays on the Reels card (D2), Mac-gated.
 *
 * 2b: this function is the ONLY place that can answer two questions the browser cannot.
 *   storage_object_verified — the browser believes its uploads landed because supabase-js
 *     returned no error. It has no read access to reel-sources (there is no SELECT policy on
 *     that bucket), so it can never confirm it. Service role can. Three reels' worth of clips
 *     exist in storage with no EDL row; this is where that divergence becomes observable.
 *   wf1_triggered — the browser receives Netlify's 202 at invocation and never sees WF1's
 *     actual status. That 200/502 existed only in this function's log until now.
 *
 * ⚠️ VERIFICATION IS OBSERVATIONAL ONLY. A missing or mismatched object does NOT block the
 * WF1 fire. Making it fatal would change live create behaviour on the strength of a check
 * that has never run in production, which is how an instrument becomes an outage. Decide
 * that on evidence, later.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fidhmvuurygpknhshpml.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WF1_URL = process.env.WF1_WEBHOOK_URL || 'https://jmac.app.n8n.cloud/webhook/fca/wf1-edit-planner';
const WF1_SECRET = process.env.WF1_WEBHOOK_SECRET;
const BUCKET = 'reel-sources';

const rest = (path, opts = {}) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
  ...opts,
  headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

// Membership parity with the reel-sources INSERT policy (get_my_studio_ids = active instructor OR client).
async function isStudioMember(email, studioId) {
  if (!email || !studioId) return false;
  const e = encodeURIComponent(email);
  const s = encodeURIComponent(studioId);
  const [insR, cliR] = await Promise.all([
    rest(`studio_instructors?studio_id=eq.${s}&instructor_email=eq.${e}&status=eq.active&select=id&limit=1`),
    rest(`clients?studio_id=eq.${s}&email=eq.${e}&select=id&limit=1`),
  ]);
  const ins = await insR.json().catch(() => []);
  const cli = await cliR.json().catch(() => []);
  return (Array.isArray(ins) && ins.length > 0) || (Array.isArray(cli) && cli.length > 0);
}

/**
 * Server-side telemetry. source='server_fn' — the §7 emitter distinction. auth_user_id is
 * left unset: service_role has no auth.uid(), and the 2a migration dropped that column's
 * NOT NULL precisely so this path could exist.
 *
 * Never throws and never blocks the caller. A telemetry failure must not become a create
 * failure; that would make the observability worse than none.
 */
async function emitServer(rows) {
  if (!SERVICE_KEY || !rows.length) return;
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/upload_events', {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows.map((r) => ({
        source: 'server_fn',
        occurred_at: new Date().toISOString(),
        event_type: `${r.stage}_${r.outcome}`,
        ...r,
      }))),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[reel-create] telemetry insert failed:', res.status, t.slice(0, 300));
    }
  } catch (e) {
    console.error('[reel-create] telemetry threw:', e.message);
  }
}

/**
 * One list call per reel prefix, not one HEAD per clip: storage list returns name + metadata
 * (size) for the whole folder, so N clips cost one round trip. No signed URL is minted — a
 * signed URL is a credential with a TTL, and issuing one to answer "does this exist" would
 * put a bearer token in a log line for no gain.
 */
async function listPrefix(studioId, reelId) {
  try {
    const res = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + BUCKET, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: `${studioId}/${reelId}`, limit: 200, offset: 0 }),
    });
    if (!res.ok) {
      console.error('[reel-create] storage list failed:', res.status);
      return null; // null means UNCHECKED, which is not the same as "missing"
    }
    const items = await res.json();
    const map = new Map();
    for (const it of Array.isArray(items) ? items : []) {
      map.set(`${studioId}/${reelId}/${it.name}`, Number(it?.metadata?.size ?? NaN));
    }
    return map;
  } catch (e) {
    console.error('[reel-create] storage list threw:', e.message);
    return null;
  }
}

exports.handler = async (event) => {
  const done = (status, msg) => { if (status >= 400) console.error('[reel-create] ' + status + ': ' + msg); return { statusCode: status, body: msg }; };
  if (event.httpMethod !== 'POST') return done(405, 'method not allowed');
  if (!SERVICE_KEY) return done(500, 'SUPABASE_SERVICE_ROLE_KEY not configured');
  if (!WF1_SECRET) return done(500, 'WF1_WEBHOOK_SECRET not configured');

  const authz = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authz.replace(/^Bearer\s+/i, '').trim();
  if (!token) return done(401, 'missing auth token');
  const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token } });
  if (!userRes.ok) return done(401, 'invalid or expired session');
  const authUser = await userRes.json().catch(() => null);
  const email = authUser && authUser.email ? authUser.email : null;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return done(400, 'invalid JSON'); }
  const m = body.manifest || {};
  const clips = Array.isArray(m.source_clips) ? m.source_clips : [];
  if (!m.reel_id || !m.studio_id) return done(400, 'manifest requires reel_id and studio_id');
  if (!clips.length) return done(400, 'manifest requires at least one source clip');
  if (!clips.every((c) => c && typeof c.storage_path === 'string' && c.clip_id)) return done(400, 'each source_clip needs clip_id and storage_path');

  if (!(await isStudioMember(email, m.studio_id))) return done(403, 'session is not a member of this studio');
  const prefix = m.studio_id + '/';
  if (!clips.every((c) => c.storage_path.startsWith(prefix))) return done(400, 'clip paths must be under the studio folder');

  // The correlation id ties the server's rows to the browser's rows for the same attempt.
  // Header first (it survives a manifest the client failed to populate), manifest second.
  const correlationId = event.headers['x-correlation-id']
    || event.headers['X-Correlation-Id']
    || m.correlation_id
    || null;
  if (!correlationId) console.warn('[reel-create] no correlation id on reel ' + m.reel_id);

  // --- storage_object_verified, per clip, BEFORE the fire ---
  const observed = await listPrefix(m.studio_id, m.reel_id);
  const verifyRows = [];
  let anyMismatch = false;
  for (const c of clips) {
    let mismatch_kind = 'unchecked';
    let observed_bytes = null;
    if (observed !== null) {
      if (!observed.has(c.storage_path)) {
        mismatch_kind = 'missing';
      } else {
        observed_bytes = observed.get(c.storage_path);
        if (!Number.isFinite(observed_bytes)) mismatch_kind = 'unchecked';
        else if (observed_bytes === 0) mismatch_kind = 'zero';
        else if (Number.isFinite(Number(c.client_bytes)) && Number(c.client_bytes) !== observed_bytes) mismatch_kind = 'size_mismatch';
        else mismatch_kind = null; // clean
      }
    }
    const ok = mismatch_kind === null;
    if (!ok && mismatch_kind !== 'unchecked') anyMismatch = true;
    verifyRows.push({
      attempt_id: correlationId,
      studio_id: m.studio_id,
      reel_id: m.reel_id,
      stage: 'storage_object_verified',
      outcome: ok ? 'ok' : 'fail',
      clip_index: c.uploaded_order ?? null,
      clip_count: clips.length,
      storage_bucket: BUCKET,
      storage_path: c.storage_path,
      observed_bytes: observed_bytes,
      file_size_bytes: Number.isFinite(Number(c.client_bytes)) ? Number(c.client_bytes) : null,
      error_code: ok ? null : (mismatch_kind || 'unchecked'),
      payload: {
        surface: 'reel-create-background',
        mismatch_kind: ok ? null : (mismatch_kind || 'unchecked'),
        clip_id: c.clip_id,
        list_available: observed !== null,
      },
    });
  }
  // Awaited: this function has 15 minutes of headroom, and a fire-and-forget insert in a
  // background function can be cut off when the invocation ends.
  if (correlationId) await emitServer(verifyRows);
  if (anyMismatch) console.warn('[reel-create] storage verification mismatch on reel ' + m.reel_id + ' — firing WF1 anyway (observational only)');

  // --- fire WF1, unchanged ---
  try {
    const wh = await fetch(WF1_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wf1-secret': WF1_SECRET },
      body: JSON.stringify(m),
    });
    const text = await wh.text();
    console.log('[reel-create] reel ' + m.reel_id + ' WF1 status=' + wh.status + ' body=' + text.slice(0, 300));

    // response_state distinguishes the three shapes that all used to read as "fired":
    // a real 2xx with a body, a 2xx with an EMPTY body (what a node that dies before its
    // Respond returns — the chat agent failed exactly this way for six months), and a non-2xx.
    const trimmed = (text || '').trim();
    const response_state = !wh.ok ? 'http_error' : (trimmed.length === 0 ? 'empty_body' : 'body');
    if (correlationId) {
      await emitServer([{
        attempt_id: correlationId,
        studio_id: m.studio_id,
        reel_id: m.reel_id,
        stage: 'wf1_triggered',
        outcome: wh.ok ? 'ok' : 'fail',
        clip_count: clips.length,
        http_status: wh.status,
        error_code: wh.ok ? null : 'wf1_http_' + wh.status,
        error_message: wh.ok ? null : trimmed.slice(0, 500),
        payload: { surface: 'reel-create-background', response_state, body_bytes: trimmed.length },
      }]);
    }
    return { statusCode: wh.ok ? 200 : 502, body: text.slice(0, 500) };
  } catch (err) {
    if (correlationId) {
      await emitServer([{
        attempt_id: correlationId,
        studio_id: m.studio_id,
        reel_id: m.reel_id,
        stage: 'wf1_triggered',
        outcome: 'fail',
        clip_count: clips.length,
        http_status: null,
        error_code: 'wf1_unreachable',
        error_message: String(err && err.message).slice(0, 500),
        payload: { surface: 'reel-create-background', response_state: 'threw' },
      }]);
    }
    return done(502, 'WF1 fire failed: ' + err.message);
  }
};

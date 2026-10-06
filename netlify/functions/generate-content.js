exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  // C5: every POST gets a durable generate_proxy_calls row. The insert starts now, runs alongside
  // the checks below, and is awaited before n8n is called; the outcome is written before we return.
  const trace = openTrace(event);
  const res = await handle(event, trace);
  await trace.close(res);
  return res;
};

async function handle(event, trace) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!webhookUrl || !supabaseUrl || !anonKey) {
    const missing = [
      !webhookUrl && 'N8N_WEBHOOK_URL',
      !supabaseUrl && 'SUPABASE_URL',
      !anonKey && 'SUPABASE_ANON_KEY',
    ].filter(Boolean).join(', ');
    console.error('[generate-content] missing env:', missing);
    return refuse(trace, 500, 'not_configured', { error: 'Content generation is not configured.' });
  }

  // AG-1.8: shared-secret header for the generator webhook. Production-only by design:
  // deploy previews and branch deploys have no key, so they get 403. n8n enforces it (header auth
  // on the generator webhook since 2026-09-28), so this proxy is the only way in.
  const generatorKey = readGeneratorKey();

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return refuse(trace, 400, 'invalid_json', { error: 'Invalid JSON' });
  }
  // JSON.parse('null') and friends succeed; everything below needs an object.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return refuse(trace, 400, 'invalid_json', { error: 'Invalid JSON' });
  }

  // --- authenticate the caller (session only; membership and role are derived below) ---------
  // Without this the function is an open relay: it validated body SHAPE only,
  // so anyone with a studio_id could spend Claude budget, write deliveries and
  // email that studio's owner. studio_id is an unguessable UUID, but every
  // instructor already holds one — including former instructors.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return refuse(trace, 401, 'no_token', { error: 'Sign in again to generate content.' });
  }

  // verifiedEmail is forwarded as GoTrue stored it; callerEmail is the lowercased copy used only
  // for comparisons.
  let verifiedEmail;
  try {
    const who = await fetch(supabaseUrl.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + token },
    });
    if (!who.ok) return refuse(trace, 401, 'session_rejected', { error: 'Your session has expired. Reload and sign in again.' });
    const user = await who.json();
    verifiedEmail = (user && typeof user.email === 'string') ? user.email.trim() : '';
    trace.set({ auth_user_id: user && typeof user.id === 'string' && UUID.test(user.id) ? user.id.toLowerCase() : null });
  } catch (err) {
    console.error('[generate-content] session check failed:', err.message);
    return refuse(trace, 502, 'session_check_failed', { error: 'Could not verify your session. Please try again.' });
  }
  if (!verifiedEmail) {
    return refuse(trace, 401, 'session_no_email', { error: 'Your session has expired. Reload and sign in again.' });
  }
  const callerEmail = verifiedEmail.toLowerCase();

  // --- identity is derived here, never taken from the body (HQ 2026-09-29) --------------------
  // The generator trusts body.email and body.user_role. `user_role: "studio_instructor"` skips
  // its paywall, and body.email picks whose posts_used is written and who gets the content.
  // Both were forwarded as sent, so any signed-in owner could skip the trial cap and cancel
  // check, or write to another tenant's counter and inbox (reproduced 09-29, execs 73742 and
  // 73744). Whatever the browser sent for these two is dropped before anything reads it.
  delete body.email;
  delete body.user_role;

  if (typeof body.studio_id !== 'string' || !UUID.test(body.studio_id)) {
    return refuse(trace, 400, 'bad_studio_id', { error: 'studio_id is required' });
  }
  if (body.client_id != null && (typeof body.client_id !== 'string' || !UUID.test(body.client_id))) {
    return refuse(trace, 400, 'bad_client_id', { error: 'client_id is invalid' });
  }
  if (!Array.isArray(body.platforms) || body.platforms.length === 0) {
    return refuse(trace, 400, 'no_platforms', { error: 'At least one platform is required' });
  }
  // HQ 2026-09-29: postCount decides how many posts one run writes (Claude spend), and the trial
  // cap is checked BEFORE the run against posts already used, never against posts requested. So
  // the request size is bounded here, to what the modal can send. Every entry must carry an
  // explicit integer: the generator reads a missing postCount, or a bare string entry, as 3.
  let requested = 0;
  for (const p of body.platforms) {
    const n = p && typeof p === 'object' && !Array.isArray(p) ? p.postCount : undefined;
    if (!Number.isInteger(n) || n < 1 || n > MAX_POSTS_PER_PLATFORM) {
      return refuse(trace, 400, 'bad_post_count', { error: 'Each platform needs a post count from 1 to ' + MAX_POSTS_PER_PLATFORM + '.' });
    }
    requested += n;
  }
  if (requested > MAX_POSTS_PER_REQUEST) {
    return refuse(trace, 400, 'too_many_posts', { error: 'At most ' + MAX_POSTS_PER_REQUEST + ' posts per request.' });
  }
  // Postgres returns uuids lowercase; compare like with like.
  body.studio_id = body.studio_id.toLowerCase();
  if (body.client_id != null) body.client_id = body.client_id.toLowerCase();

  // Every read below uses the CALLER's token, so RLS bounds what can be seen: a studio the
  // caller has no membership in returns no row, and that is a 403.
  const rest = (path) => fetch(supabaseUrl.replace(/\/+$/, '') + '/rest/v1/' + path, {
    headers: { apikey: anonKey, Authorization: 'Bearer ' + token },
  });
  const sid = encodeURIComponent(body.studio_id);
  const RETRY = 'Could not verify your studio. Please try again.';
  let role;
  try {
    // One round of parallel reads. The clients read depends only on body.client_id, so it rides
    // along rather than adding a serial round trip ahead of the 25s generator window.
    const [saRes, siRes, cRes] = await Promise.all([
      rest('studio_accounts?select=id,owner_email&id=eq.' + sid),
      rest('studio_instructors?select=instructor_email&status=eq.active&studio_id=eq.' + sid),
      body.client_id != null
        ? rest('clients?select=id,studio_id,email&id=eq.' + encodeURIComponent(body.client_id))
        : null,
    ]);
    if (!saRes.ok || !siRes.ok || (cRes && !cRes.ok)) {
      console.error('[generate-content] role lookup failed:', saRes.status, siRes.status, cRes ? cRes.status : '-');
      return refuse(trace, 502, 'membership_lookup_failed', { error: RETRY });
    }
    const [sa, si, cl] = await Promise.all([saRes.json(), siRes.json(), cRes ? cRes.json() : null]);
    const studio = Array.isArray(sa) ? sa.find((r) => r && r.id === body.studio_id) : null;
    // Owner: studio_accounts.owner_email (parity with _authz isStudioOwner). Instructor: an ACTIVE
    // studio_instructors row for this studio. A clients row alone is NOT membership here, unlike
    // _authz isStudioMember: former instructors keep theirs after they are set inactive. Do not
    // swap this for requireStudioAccess(..., 'member').
    if (studio && lower(studio.owner_email) === callerEmail) {
      role = 'studio_owner';
    } else if (studio && Array.isArray(si) && si.some((r) => r && lower(r.instructor_email) === callerEmail)) {
      role = 'studio_instructor';
    } else {
      console.error('[generate-content] no owner or active-instructor membership on the named studio');
      return refuse(trace, 403, 'not_member', { error: 'You do not have access to that studio.' });
    }

    if (body.client_id != null) {
      // A client_id must be under the studio named (400), and it must be the CALLER's own row
      // (403). The generator keys the trial cap, posts_used, the success email and the
      // delivery's instructor_email on body.email. If a client_id could name any row in the
      // studio, an owner could run the cap against an instructor's counter, and an instructor
      // (whose clients row makes the whole studio's clients visible under RLS) could send as
      // the owner. The app only ever sends the caller's own row.
      const client = Array.isArray(cl) ? cl.find((r) => r && r.id === body.client_id) : null;
      if (!client || client.studio_id !== body.studio_id) {
        return refuse(trace, 400, 'client_not_in_studio', { error: 'client_id does not belong to that studio' });
      }
      if (lower(client.email) !== callerEmail) {
        console.error('[generate-content] client_id is not the caller\'s own row');
        return refuse(trace, 403, 'client_not_caller', { error: 'You do not have access to that client.' });
      }
    }
  } catch (err) {
    console.error('[generate-content] role check failed:', err.message);
    return refuse(trace, 502, 'role_check_failed', { error: RETRY });
  }

  // --- regenerate lineage (WO-4 N2, HQ 2026-09-29) ---------------------------------------------
  // The generator writes content_deliveries.regenerated_from straight from body.regenerate_of and
  // checks nothing itself, so this is the only gate. The entitlement WO will read that link to
  // decide what is free, so a forged link is a free generation. A regenerate is accepted only for
  // an ORIGINAL, FLAGGED delivery in the named studio that has not been regenerated yet.
  // Clients never set regenerated_from: a value sent under that name is dropped.
  delete body.regenerated_from;
  if (body.regenerate_of != null) {
    // Owner-only (Mac 2026-10-05). `role` is the server-derived role above (HQ 2026-09-29,
    // 7a88fc3); body.user_role was deleted before anything read it, so it can't be claimed.
    // Also closes the instructor-visibility gap: an instructor can't see an owner's regenerate
    // under RLS, so the "already regenerated" read below would miss it.
    if (role !== 'studio_owner') {
      return refuse(trace, 403, 'regenerate_not_owner', { error: 'Only the studio owner can regenerate a post.' });
    }
    const refusal = await checkRegenerateOf(rest, body, trace);
    if (refusal) return refusal;
  } else {
    delete body.regenerate_of;
  }

  body.email = verifiedEmail;
  body.user_role = role;
  trace.set({ caller_role: role, posts_requested: requested });

  // C5: the in-flight row must exist before n8n is called. A failed insert never blocks the
  // generation; the trace raises the alert instead (see openTrace).
  await trace.opened;

  // Send request to n8n. n8n webhook is responseMode=lastNode, so it holds the connection open
  // until the full pipeline completes (~50-85s with Claude). Past the window we return 202
  // Accepted: n8n keeps processing and saves results to content_deliveries, and the React app
  // polls for results. The window is measured from the START of this invocation, not from here,
  // and leaves CLOSE_RESERVE_MS for the trace's outcome write: a function killed at Netlify's 26s
  // limit before that write would leave every normal run looking like a crash.
  const upstreamWindowMs = Math.max(1000, UPSTREAM_DEADLINE_MS - CLOSE_RESERVE_MS - (Date.now() - trace.startedAt));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upstreamWindowMs);
  let upstreamLogged = false;
  let n8nStatus = null;
  const forwardedAt = Date.now();
  trace.set({ forwarded_at: new Date(forwardedAt).toISOString(), generator_key_sent: Boolean(generatorKey) });

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(generatorKey ? { 'X-FCA-Proxy-Key': generatorKey } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Never follow a redirect: a custom header survives a cross-origin redirect, so following
      // one could hand X-FCA-Proxy-Key to whatever host it names. A 3xx fails as 'network'.
      redirect: 'error',
    });
    clearTimeout(timeout);
    n8nStatus = res.status;
    trace.set({ outcome: 'n8n_response', n8n_status: res.status, n8n_ms: Date.now() - forwardedAt });
    if (!res.ok) {
      // AG-1.8(c), HQ 09-28: surface upstream rejections (e.g. 403 once header auth is on). Status only.
      logUpstreamError({ status: res.status });
      upstreamLogged = true;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return respond(res.status, data);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      // Timeout — n8n is still processing, will save results when done. This is the NORMAL path
      // (runs take ~50-85s), so it gets its own tag and never counts as an upstream error.
      trace.set({ outcome: 'n8n_timeout', n8n_ms: Date.now() - forwardedAt });
      console.log(JSON.stringify({ tag: 'generate_upstream_pending' }));
      return respond(202, { success: true, message: 'Content generation in progress. Results will appear in your deliveries.' });
    }
    // A body-read failure after a non-2xx was already logged with its status: log once, not twice.
    // n8n did answer in that case, so the trace keeps outcome n8n_response with its status.
    if (!upstreamLogged) logUpstreamError({ kind: 'network' });
    if (n8nStatus == null) trace.set({ outcome: 'n8n_network_error', n8n_ms: Date.now() - forwardedAt });
    console.error('[generate-content] Upstream fetch failed:', err.message);
    // err.message stays server-side only: it can carry the webhook URL. The modal shows `error`.
    return respond(502, { error: 'Upstream request failed' });
  }
}

// The whole invocation must finish inside Netlify's 26s sync-function limit.
const UPSTREAM_DEADLINE_MS = 25000;
const CLOSE_RESERVE_MS = 1500;

// Mirrors GenerateModal: a 1-5 post-count select on each of the 5 platforms. Raise these together
// with the modal, never on their own.
const MAX_POSTS_PER_PLATFORM = 5;
const MAX_POSTS_PER_REQUEST = 25;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// WO-4 N2. Returns a response to send (a refusal) or null (accepted; body.regenerate_of is
// normalized). Both reads use the CALLER's token, so RLS bounds them: another studio's delivery,
// and an instructor's view of a delivery that isn't theirs, both come back as no row, and that is
// the same 403 as a wrong studio. Nothing here reads content, only ids and flags.
// The partial unique index content_deliveries_regenerated_from_uq (WO-4 Phase M, M3; applied on
// fca-studio 2026-10-01 as migration wo4_m3_content_deliveries_flag_regen) is the backstop for two
// regenerates racing past the "already regenerated" read: the second fails at the generator's insert.
async function checkRegenerateOf(rest, body, trace) {
  if (typeof body.regenerate_of !== 'string' || !UUID.test(body.regenerate_of)) {
    return refuse(trace, 400, 'regenerate_invalid', { error: 'regenerate_of is invalid' });
  }
  body.regenerate_of = body.regenerate_of.toLowerCase();
  const rid = encodeURIComponent(body.regenerate_of);
  let original, existing;
  try {
    const [oRes, eRes] = await Promise.all([
      rest('content_deliveries?select=id,studio_id,quality_flag,regenerated_from&id=eq.' + rid),
      rest('content_deliveries?select=id&regenerated_from=eq.' + rid + '&limit=1'),
    ]);
    if (!oRes.ok || !eRes.ok) {
      console.error('[generate-content] regenerate lookup failed:', oRes.status, eRes.status);
      return refuse(trace, 502, 'regenerate_lookup_failed', { error: 'Could not check that post. Please try again.' });
    }
    const [o, e] = await Promise.all([oRes.json(), eRes.json()]);
    original = Array.isArray(o) ? o.find((r) => r && r.id === body.regenerate_of) : null;
    existing = Array.isArray(e) && e.length > 0;
  } catch (err) {
    console.error('[generate-content] regenerate lookup failed:', err.message);
    return refuse(trace, 502, 'regenerate_lookup_failed', { error: 'Could not check that post. Please try again.' });
  }
  if (!original || original.studio_id !== body.studio_id) {
    console.error('[generate-content] regenerate_of is not a delivery of the named studio');
    return refuse(trace, 403, 'regenerate_not_visible', { error: 'You do not have access to that post.' });
  }
  if (original.quality_flag !== true) {
    return refuse(trace, 409, 'regenerate_not_flagged', { error: 'Only a post marked "Check before posting" can be regenerated.' });
  }
  if (original.regenerated_from != null) {
    return refuse(trace, 409, 'regenerate_is_regenerate', { error: 'This post is already a regenerate, so it can\'t be regenerated again.' });
  }
  if (existing) {
    return refuse(trace, 409, 'regenerate_already_done', { error: 'This post has already been regenerated.' });
  }
  return null;
}

// --- C5 trace: one generate_proxy_calls row per call (Mac 2026-10-05) -------------------------
// Counts and ids only: never post text, prompts, email addresses, response bodies or the key.
// Written with the service role because the row must exist for callers the proxy refuses before
// it knows who they are (no token, bad JSON), and because a table the browser could write would
// let anyone forge the record this exists to provide. The table grants anon and authenticated
// nothing. A trace failure never changes what the caller gets: generation still runs and an alert
// fires instead (Slack, plus a `generate_trace_write_failed` log line in case Slack is down too).
const TRACE_INSERT_TIMEOUT_MS = 3000;
const TRACE_CLOSE_TIMEOUT_MS = 1200;
const ALERT_TIMEOUT_MS = 1500;
const TRACED_IDS = ['client_request_id', 'studio_id', 'slot_id', 'client_id', 'regenerate_of'];

function openTrace(event) {
  const startedAt = Date.now();
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID() : null;
  const pending = {};
  let reason = null;
  let alerting = null;
  let insertedOk = false;

  // Ids as SENT, uuid-shaped only (a refusal must record what was asked for); counts as sent.
  // Parsed separately from the handler so the row can be written before any check runs.
  let sent = null;
  try { sent = JSON.parse(event.body); } catch { /* the handler records it as invalid_json */ }
  const ids = {};
  if (sent && typeof sent === 'object' && !Array.isArray(sent)) {
    for (const k of TRACED_IDS) {
      if (typeof sent[k] === 'string' && UUID.test(sent[k])) ids[k] = sent[k].toLowerCase();
    }
    if (Array.isArray(sent.platforms)) ids.platform_count = Math.min(sent.platforms.length, 32767);
  }

  // One alert per call at most. detail carries statuses, error names and the outcome, never a body.
  const alert = (stage, detail) => {
    console.error(JSON.stringify({ tag: 'generate_trace_write_failed', stage, ...detail, trace_id: id }));
    const webhook = process.env.SLACK_WEBHOOK_URL;
    if (alerting || !webhook) return;
    const lines = [
      ':rotating_light: *Generate trace write failed* (' + stage + '). The generation was NOT blocked; this call has no complete generate_proxy_calls row.',
      '*Trace:* ' + (id || 'none') + '  *Request:* ' + (ids.client_request_id || 'n/a') + '  *Studio (as sent):* ' + (ids.studio_id || 'n/a'),
      '*Detail:* ' + Object.entries(detail).map(([k, v]) => k + '=' + v).join(' '),
    ];
    alerting = timed(ALERT_TIMEOUT_MS, (signal) => fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
      signal,
    })).then((r) => {
      // Status only: a webhook error body can echo the URL back.
      if (!r.ok) console.error('[generate-content] trace alert rejected by Slack:', r.status);
    }).catch((e) => console.error('[generate-content] trace alert failed:', e.name));
  };

  const write = (method, query, row, ms) => timed(ms, (signal) => fetch(supabaseUrl + '/rest/v1/generate_proxy_calls' + query, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      // On the PATCH, count=exact makes a 0-row match visible: PostgREST answers 2xx either way.
      Prefer: method === 'POST' ? 'return=minimal' : 'return=minimal,count=exact',
    },
    body: JSON.stringify(row),
    signal,
  }));

  const opened = (async () => {
    if (!supabaseUrl || !serviceKey || !id) {
      alert('insert', { reason: 'not_configured' });
      return;
    }
    try {
      const r = await write('POST', '', { id, ...ids }, TRACE_INSERT_TIMEOUT_MS);
      if (r.ok) insertedOk = true;
      else alert('insert', { status: r.status });
    } catch (e) {
      alert('insert', { error: e.name });
    }
  })();

  return {
    startedAt,
    opened,
    set(fields) { Object.assign(pending, fields); },
    refused(r) { reason = r; },
    async close(res) {
      await opened;
      if (insertedOk) {
        const now = Date.now();
        const row = {
          ...pending,
          outcome: reason ? 'refused' : (pending.outcome || null),
          refusal_reason: reason,
          response_status: res && Number.isInteger(res.statusCode) ? res.statusCode : null,
          duration_ms: now - startedAt,
          completed_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        };
        try {
          const r = await write('PATCH', '?id=eq.' + id, row, TRACE_CLOSE_TIMEOUT_MS);
          const range = r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-range') : null;
          if (!r.ok) alert('update', { status: r.status, outcome: row.outcome || 'none' });
          else if (range && /\/0$/.test(range)) alert('update', { matched: 0, outcome: row.outcome || 'none' });
        } catch (e) {
          alert('update', { error: e.name, outcome: row.outcome || 'none' });
        }
      }
      if (alerting) await alerting;
    },
  };
}

// Records the reason on the trace and builds the same response respond() would.
function refuse(trace, status, reason, body) {
  trace.refused(reason);
  return respond(status, body);
}

// Runs fn(signal) and aborts it after ms. Rejects with an AbortError on timeout.
async function timed(ms, fn) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fn(c.signal); } finally { clearTimeout(t); }
}

function lower(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

// AG-1.8: the key must be a single header-safe token (printable ASCII, no whitespace). A value
// with a line break makes fetch throw an error whose message contains the value, so a malformed
// key is dropped here (logged by NAME only) rather than sent.
function readGeneratorKey() {
  const key = process.env.N8N_GENERATOR_KEY;
  if (!key) {
    console.warn('[generate-content] N8N_GENERATOR_KEY not set; generator call sends no X-FCA-Proxy-Key');
    return null;
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    console.error('[generate-content] N8N_GENERATOR_KEY is malformed (not a single printable token); sending no X-FCA-Proxy-Key');
    return null;
  }
  return key;
}

// AG-1.8(c): one structured line per upstream failure, readable in Netlify function logs.
// `status` is always a number (a non-2xx HTTP status); a fetch failure is `kind: 'network'`.
// Never the key, the request body, or a studio id. Satisfied via function log, not the AG-1.7
// event path (HQ 09-28). The 202 timeout path logs `generate_upstream_pending` instead.
function logUpstreamError(fields) {
  console.error(JSON.stringify({ tag: 'generate_upstream_error', ...fields }));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.DASHBOARD_ORIGIN || 'https://studio-dash.netlify.app',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function respond(status, body) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

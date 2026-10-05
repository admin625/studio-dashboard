exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

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
    return respond(500, { error: 'Content generation is not configured.' });
  }

  // AG-1.8: shared-secret header for the generator webhook. Production-only by design:
  // deploy previews and branch deploys have no key, so they get 403. n8n enforces it (header auth
  // on the generator webhook since 2026-09-28), so this proxy is the only way in.
  const generatorKey = readGeneratorKey();

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }
  // JSON.parse('null') and friends succeed; everything below needs an object.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return respond(400, { error: 'Invalid JSON' });
  }

  // --- authenticate the caller (session only; membership and role are derived below) ---------
  // Without this the function is an open relay: it validated body SHAPE only,
  // so anyone with a studio_id could spend Claude budget, write deliveries and
  // email that studio's owner. studio_id is an unguessable UUID, but every
  // instructor already holds one — including former instructors.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return respond(401, { error: 'Sign in again to generate content.' });
  }

  // verifiedEmail is forwarded as GoTrue stored it; callerEmail is the lowercased copy used only
  // for comparisons.
  let verifiedEmail;
  try {
    const who = await fetch(supabaseUrl.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + token },
    });
    if (!who.ok) return respond(401, { error: 'Your session has expired. Reload and sign in again.' });
    const user = await who.json();
    verifiedEmail = (user && typeof user.email === 'string') ? user.email.trim() : '';
  } catch (err) {
    console.error('[generate-content] session check failed:', err.message);
    return respond(502, { error: 'Could not verify your session. Please try again.' });
  }
  if (!verifiedEmail) {
    return respond(401, { error: 'Your session has expired. Reload and sign in again.' });
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
    return respond(400, { error: 'studio_id is required' });
  }
  if (body.client_id != null && (typeof body.client_id !== 'string' || !UUID.test(body.client_id))) {
    return respond(400, { error: 'client_id is invalid' });
  }
  if (!Array.isArray(body.platforms) || body.platforms.length === 0) {
    return respond(400, { error: 'At least one platform is required' });
  }
  // HQ 2026-09-29: postCount decides how many posts one run writes (Claude spend), and the trial
  // cap is checked BEFORE the run against posts already used, never against posts requested. So
  // the request size is bounded here, to what the modal can send. Every entry must carry an
  // explicit integer: the generator reads a missing postCount, or a bare string entry, as 3.
  let requested = 0;
  for (const p of body.platforms) {
    const n = p && typeof p === 'object' && !Array.isArray(p) ? p.postCount : undefined;
    if (!Number.isInteger(n) || n < 1 || n > MAX_POSTS_PER_PLATFORM) {
      return respond(400, { error: 'Each platform needs a post count from 1 to ' + MAX_POSTS_PER_PLATFORM + '.' });
    }
    requested += n;
  }
  if (requested > MAX_POSTS_PER_REQUEST) {
    return respond(400, { error: 'At most ' + MAX_POSTS_PER_REQUEST + ' posts per request.' });
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
      return respond(502, { error: RETRY });
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
      return respond(403, { error: 'You do not have access to that studio.' });
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
        return respond(400, { error: 'client_id does not belong to that studio' });
      }
      if (lower(client.email) !== callerEmail) {
        console.error('[generate-content] client_id is not the caller\'s own row');
        return respond(403, { error: 'You do not have access to that client.' });
      }
    }
  } catch (err) {
    console.error('[generate-content] role check failed:', err.message);
    return respond(502, { error: RETRY });
  }

  // --- regenerate lineage (WO-4 N2, HQ 2026-09-29) ---------------------------------------------
  // The generator writes content_deliveries.regenerated_from straight from body.regenerate_of and
  // checks nothing itself, so this is the only gate. The entitlement WO will read that link to
  // decide what is free, so a forged link is a free generation. A regenerate is accepted only for
  // an ORIGINAL, FLAGGED delivery in the named studio that has not been regenerated yet.
  // Clients never set regenerated_from: a value sent under that name is dropped.
  delete body.regenerated_from;
  if (body.regenerate_of != null) {
    const refusal = await checkRegenerateOf(rest, body);
    if (refusal) return refusal;
  } else {
    delete body.regenerate_of;
  }

  body.email = verifiedEmail;
  body.user_role = role;

  // Send request to n8n with a 25s timeout (Netlify Pro max is 26s).
  // n8n webhook is responseMode=lastNode, so it holds the connection open
  // until the full pipeline completes (~35-60s with Claude). If it takes
  // longer than 25s, we return 202 Accepted — n8n keeps processing and
  // saves results to content_deliveries. The React app polls for results.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  let upstreamLogged = false;

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
      console.log(JSON.stringify({ tag: 'generate_upstream_pending' }));
      return respond(202, { success: true, message: 'Content generation in progress. Results will appear in your deliveries.' });
    }
    // A body-read failure after a non-2xx was already logged with its status: log once, not twice.
    if (!upstreamLogged) logUpstreamError({ kind: 'network' });
    console.error('[generate-content] Upstream fetch failed:', err.message);
    // err.message stays server-side only: it can carry the webhook URL. The modal shows `error`.
    return respond(502, { error: 'Upstream request failed' });
  }
};

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
async function checkRegenerateOf(rest, body) {
  if (typeof body.regenerate_of !== 'string' || !UUID.test(body.regenerate_of)) {
    return respond(400, { error: 'regenerate_of is invalid' });
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
      return respond(502, { error: 'Could not check that post. Please try again.' });
    }
    const [o, e] = await Promise.all([oRes.json(), eRes.json()]);
    original = Array.isArray(o) ? o.find((r) => r && r.id === body.regenerate_of) : null;
    existing = Array.isArray(e) && e.length > 0;
  } catch (err) {
    console.error('[generate-content] regenerate lookup failed:', err.message);
    return respond(502, { error: 'Could not check that post. Please try again.' });
  }
  if (!original || original.studio_id !== body.studio_id) {
    console.error('[generate-content] regenerate_of is not a delivery of the named studio');
    return respond(403, { error: 'You do not have access to that post.' });
  }
  if (original.quality_flag !== true) {
    return respond(409, { error: 'Only a post marked "Check before posting" can be regenerated.' });
  }
  if (original.regenerated_from != null) {
    return respond(409, { error: 'This post is already a regenerate, so it can\'t be regenerated again.' });
  }
  if (existing) {
    return respond(409, { error: 'This post has already been regenerated.' });
  }
  return null;
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

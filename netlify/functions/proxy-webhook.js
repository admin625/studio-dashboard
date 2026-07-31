// Authenticated server-side proxy to the n8n webhooks the dashboard calls.
//
// Previously this validated only the `target` query param: no authentication of
// any kind, Access-Control-Allow-Origin '*', and a hardcoded fallback URL in a
// PUBLIC repo. Anyone could POST to it and drive a live workflow — verified on
// 2026-07-31 by an unauthenticated empty-body call to target=photo-editor,
// which returned 200 and produced two real (failed) workflow executions.
//
// Now: every request must carry a valid Supabase session, and if the body names
// a studio the caller must own it. Per-target shared secrets are attached
// server-side so the n8n webhooks can reject anything that did not come through
// here — the upstream URLs are never exposed to the browser.

const TARGETS = {
  'photo-editor': 'N8N_PHOTO_EDITOR_URL',
  'video-reel': 'N8N_VIDEO_REEL_URL',
  'fca-carousel': 'N8N_CAROUSEL_URL',
  'ai-photo': 'N8N_AI_PHOTO_URL',
};

// Per-target shared secret, sent as x-<target>-secret when the env var is set.
// Absent env var => no header, which keeps a target working before its
// workflow-side Auth Check exists. Arming a new target is one line here.
const SECRETS = {
  'ai-photo': { env: 'AI_PHOTO_WEBHOOK_SECRET', header: 'x-ai-photo-secret' },
};

// NOTE: no DEFAULTS map. A hardcoded upstream URL here is published, because
// this repo is public — that is how the fca-ai-photo path leaked.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const params = event.queryStringParameters || {};
  const target = params.target;
  if (!target || !TARGETS[target]) {
    return respond(400, { error: 'Invalid target' });
  }

  const envVar = TARGETS[target];
  const webhookUrl = process.env[envVar];
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!webhookUrl) {
    console.error('[proxy-webhook] ' + envVar + ' is not set');
    return respond(500, { error: 'This feature is not configured.' });
  }
  if (!supabaseUrl || !anonKey) {
    console.error('[proxy-webhook] SUPABASE_URL / SUPABASE_ANON_KEY not set');
    return respond(500, { error: 'This feature is not configured.' });
  }

  // --- authenticate the caller ---------------------------------------------
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return respond(401, { error: 'Sign in again to continue.' });
  }

  let callerEmail;
  try {
    const who = await fetch(supabaseUrl.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + token },
    });
    if (!who.ok) return respond(401, { error: 'Your session has expired. Reload and sign in again.' });
    const user = await who.json();
    callerEmail = (user && user.email) ? user.email.toLowerCase() : '';
  } catch (err) {
    console.error('[proxy-webhook] session check failed:', err.message);
    return respond(502, { error: 'Could not verify your session. Please try again.' });
  }
  if (!callerEmail) {
    return respond(401, { error: 'Your session has expired. Reload and sign in again.' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  // --- if the body names a studio, prove the caller owns it -----------------
  // Read with the CALLER's token so RLS decides what they can see.
  if (body.studio_id) {
    try {
      const scope = await fetch(
        supabaseUrl.replace(/\/+$/, '') +
        '/rest/v1/clients?select=studio_id&email=eq.' + encodeURIComponent(callerEmail),
        { headers: { apikey: anonKey, Authorization: 'Bearer ' + token } },
      );
      if (!scope.ok) {
        console.error('[proxy-webhook] studio scope lookup failed:', scope.status);
        return respond(502, { error: 'Could not verify your studio. Please try again.' });
      }
      const rows = await scope.json();
      const owned = Array.isArray(rows) ? rows.map((r) => r.studio_id).filter(Boolean) : [];
      if (!owned.includes(body.studio_id)) {
        console.error('[proxy-webhook] studio mismatch for', callerEmail, 'target', target);
        return respond(403, { error: 'You do not have access to that studio.' });
      }
    } catch (err) {
      console.error('[proxy-webhook] studio scope check failed:', err.message);
      return respond(502, { error: 'Could not verify your studio. Please try again.' });
    }
  }

  // --- relay ----------------------------------------------------------------
  const headers = { 'Content-Type': 'application/json' };
  const secret = SECRETS[target];
  if (secret && process.env[secret.env]) {
    headers[secret.header] = process.env[secret.env];
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    // A 401/403 upstream means OUR shared secret does not match the workflow's
    // Auth Check — a server misconfiguration, not the caller's problem. Passing
    // it through would tell a signed-in user to sign in again and hide the fault.
    if (secret && (res.status === 401 || res.status === 403)) {
      console.error('[proxy-webhook] upstream rejected our secret for ' + target +
                    ' — check ' + secret.env + ' matches $vars in n8n');
      return respond(503, { error: 'This feature is temporarily unavailable.' });
    }
    const text = await res.text();
    if (!text || text.trim() === '') {
      return respond(res.status, { success: res.ok, message: 'Upstream returned empty response' });
    }
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return respond(res.status, data);
  } catch (err) {
    console.error('[proxy-webhook] Upstream fetch failed:', err.message);
    return respond(502, { error: 'Upstream request failed', detail: err.message });
  }
};

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

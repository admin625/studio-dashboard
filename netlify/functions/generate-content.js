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
  // deploy previews and branch deploys have no key, so once n8n enforces it they get 403.
  const generatorKey = readGeneratorKey();

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  // --- authenticate the caller, and prove they own the studio they named -----
  // Without this the function is an open relay: it validated body SHAPE only,
  // so anyone with a studio_id could spend Claude budget, write deliveries and
  // email that studio's owner. studio_id is an unguessable UUID, but every
  // instructor already holds one — including former instructors.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return respond(401, { error: 'Sign in again to generate content.' });
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
    console.error('[generate-content] session check failed:', err.message);
    return respond(502, { error: 'Could not verify your session. Please try again.' });
  }
  if (!callerEmail) {
    return respond(401, { error: 'Your session has expired. Reload and sign in again.' });
  }

  if (body.studio_id) {
    // Read with the CALLER's token so RLS decides what they can see. If the
    // studio they named is not among their own rows, they do not own it.
    try {
      const scope = await fetch(
        supabaseUrl.replace(/\/+$/, '') +
        '/rest/v1/clients?select=studio_id&email=eq.' + encodeURIComponent(callerEmail),
        { headers: { apikey: anonKey, Authorization: 'Bearer ' + token } },
      );
      if (!scope.ok) {
        console.error('[generate-content] studio scope lookup failed:', scope.status);
        return respond(502, { error: 'Could not verify your studio. Please try again.' });
      }
      const rows = await scope.json();
      const owned = Array.isArray(rows) ? rows.map((r) => r.studio_id).filter(Boolean) : [];
      if (!owned.includes(body.studio_id)) {
        console.error('[generate-content] studio mismatch for', callerEmail);
        return respond(403, { error: 'You do not have access to that studio.' });
      }
    } catch (err) {
      console.error('[generate-content] studio scope check failed:', err.message);
      return respond(502, { error: 'Could not verify your studio. Please try again.' });
    }
  }

  if (!body.email || typeof body.email !== 'string' || !body.email.includes('@')) {
    return respond(400, { error: 'Valid email is required' });
  }
  if (!body.studio_id && !body.client_id) {
    return respond(400, { error: 'studio_id or client_id is required' });
  }
  if (!Array.isArray(body.platforms) || body.platforms.length === 0) {
    return respond(400, { error: 'At least one platform is required' });
  }

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

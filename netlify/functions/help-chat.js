// Authenticated server-side proxy to the FCA Help Chat workflow.
//
// Why this exists: the widget previously called the n8n webhook directly, which
// put https://jmac.app.n8n.cloud/webhook/<path> into the public browser bundle —
// an unauthenticated relay to the Claude API, billable, and writing no record
// anywhere. Two controls replace that:
//   1. this function verifies the caller's Supabase session before relaying;
//   2. it attaches a shared secret that the workflow's Auth Check node requires,
//      so the n8n webhook is closed to direct callers even though the old URL
//      has been public for months.
// The upstream URL lives only in env, so it is never in the repo or the bundle.

const ALLOWED_ORIGIN = process.env.DASHBOARD_ORIGIN || 'https://studio-dash.netlify.app';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const upstream = process.env.N8N_HELP_CHAT_URL;
  const sharedSecret = process.env.HELP_CHAT_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!upstream || !sharedSecret || !supabaseUrl || !anonKey) {
    // Name what is missing without echoing any value.
    const missing = [
      !upstream && 'N8N_HELP_CHAT_URL',
      !sharedSecret && 'HELP_CHAT_WEBHOOK_SECRET',
      !supabaseUrl && 'SUPABASE_URL',
      !anonKey && 'SUPABASE_ANON_KEY',
    ].filter(Boolean).join(', ');
    console.error('[help-chat] missing env:', missing);
    return respond(500, { error: 'Help chat is not configured.' });
  }

  // --- authenticate the caller -------------------------------------------
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return respond(401, { error: 'Sign in to use the help assistant.' });
  }

  let user;
  try {
    const check = await fetch(supabaseUrl.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + token },
    });
    if (!check.ok) {
      return respond(401, { error: 'Your session has expired. Reload and sign in again.' });
    }
    user = await check.json();
  } catch (err) {
    console.error('[help-chat] session check failed:', err.message);
    return respond(502, { error: 'Could not verify your session. Please try again.' });
  }
  if (!user || !user.email) {
    return respond(401, { error: 'Your session has expired. Reload and sign in again.' });
  }

  // --- validate the body --------------------------------------------------
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }
  if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
    return respond(400, { error: 'A message is required' });
  }
  if (body.message.length > 2000) {
    return respond(413, { error: 'Message is too long.' });
  }
  const history = Array.isArray(body.history) ? body.history.slice(-20) : [];

  // --- relay ---------------------------------------------------------------
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-help-chat-secret': sharedSecret,
      },
      // Caller identity comes from the verified token, never from the body.
      body: JSON.stringify({
        message: body.message.trim(),
        history,
        currentPage: typeof body.currentPage === 'string' ? body.currentPage : 'unknown',
        email: user.email,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // A 401 from upstream means OUR shared secret does not match the workflow's
    // Auth Check — a server misconfiguration, not a problem with the caller's
    // session. Passing it through would tell a correctly-signed-in user to sign
    // in again, which is the wrong action and hides the real fault.
    if (res.status === 401 || res.status === 403) {
      console.error('[help-chat] upstream rejected our shared secret — check HELP_CHAT_WEBHOOK_SECRET matches $vars.HELP_CHAT_WEBHOOK_SECRET in n8n');
      return respond(503, { error: 'The help assistant is temporarily unavailable.' });
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { reply: text }; }
    return respond(res.status, data);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return respond(504, { error: 'The help assistant took too long. Please try again.' });
    }
    console.error('[help-chat] upstream fetch failed:', err.message);
    return respond(502, { error: 'Could not reach the help assistant.' });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function respond(status, body) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

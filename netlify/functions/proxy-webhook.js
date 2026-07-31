const TARGETS = {
  'photo-editor': 'N8N_PHOTO_EDITOR_URL',
  'video-reel': 'N8N_VIDEO_REEL_URL',
  'fca-carousel': 'N8N_CAROUSEL_URL',
  'ai-photo': 'N8N_AI_PHOTO_URL',
};

// Fallback webhook URLs when env vars are not set — keeps features working out of the box
const DEFAULTS = {
  'ai-photo': 'https://jmac.app.n8n.cloud/webhook/fca-ai-photo',
};

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
  const webhookUrl = process.env[envVar] || DEFAULTS[target];
  if (!webhookUrl) {
    console.error('[proxy-webhook] ' + envVar + ' env var is not set');
    return respond(500, { error: envVar + ' is not configured. Set it in Netlify environment variables.' });
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': event.headers['content-type'] || 'application/json' },
      body: event.body,
    });
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
    'Access-Control-Allow-Headers': 'Content-Type',
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

const TARGETS = {
  'photo-editor': 'N8N_PHOTO_EDITOR_URL',
  'video-reel': 'N8N_VIDEO_REEL_URL',
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
  const webhookUrl = process.env[envVar];
  if (!webhookUrl) {
    console.error('[proxy-webhook] ' + envVar + ' env var is not set');
    return respond(500, { error: envVar + ' is not configured. Set it in Netlify environment variables.' });
  }

  // Fire-and-forget mode: send request to n8n but return 202 immediately
  // n8n workflows take 1-3+ minutes (AI generation); Netlify functions timeout at 10-26s
  if (params.fireAndForget === 'true') {
    console.log('[proxy-webhook] Fire-and-forget to', target);
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': event.headers['content-type'] || 'application/json' },
      body: event.body,
    }).catch(err => console.error('[proxy-webhook] Background request failed:', err.message));
    return respond(202, { accepted: true, message: 'Request accepted, processing in background' });
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': event.headers['content-type'] || 'application/json' },
      body: event.body,
    });
    const text = await res.text();
    console.log('[proxy-webhook] Upstream status:', res.status, 'body length:', text.length);
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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function respond(status, body) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

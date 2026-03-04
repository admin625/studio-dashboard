exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('[generate-content] N8N_WEBHOOK_URL env var is not set');
    return respond(500, { error: 'N8N_WEBHOOK_URL is not configured. Set it in Netlify environment variables.' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON' });
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

  console.log('[generate-content] Forwarding to:', webhookUrl);
  console.log('[generate-content] Payload keys:', Object.keys(body).join(', '));
  console.log('[generate-content] Platforms:', JSON.stringify(body.platforms));

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log('[generate-content] Upstream status:', res.status, 'body length:', text.length);
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return respond(res.status, data);
  } catch (err) {
    console.error('[generate-content] Upstream fetch failed:', err.message);
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

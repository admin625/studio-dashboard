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

  // Fire-and-forget: send the webhook request but don't wait for n8n to finish.
  // n8n takes 30-60+ seconds (Claude LLM call). The React app polls for results.
  // We return 202 Accepted immediately after the request is dispatched.
  try {
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(res => {
      console.log('[generate-content] Upstream responded:', res.status);
    }).catch(err => {
      console.error('[generate-content] Upstream error (async):', err.message);
    });

    return respond(202, { success: true, message: 'Content generation started. Check deliveries for results.' });
  } catch (err) {
    console.error('[generate-content] Failed to dispatch:', err.message);
    return respond(502, { error: 'Failed to dispatch request', detail: err.message });
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return respond(500, { error: 'Server misconfigured' });
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

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return respond(res.status, data);
  } catch (err) {
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

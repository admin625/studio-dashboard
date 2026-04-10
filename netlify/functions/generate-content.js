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

  // Send request to n8n with a 25s timeout (Netlify Pro max is 26s).
  // n8n webhook is responseMode=lastNode, so it holds the connection open
  // until the full pipeline completes (~35-60s with Claude). If it takes
  // longer than 25s, we return 202 Accepted — n8n keeps processing and
  // saves results to content_deliveries. The React app polls for results.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return respond(res.status, data);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      // Timeout — n8n is still processing, will save results when done
      return respond(202, { success: true, message: 'Content generation in progress. Results will appear in your deliveries.' });
    }
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

// Server-side proxy to the FCA logo-compositing service.
// Holds the Bearer secret so it never reaches the browser; forwards the POST
// body to <LOGO_COMPOSITE_SERVICE_URL>/composite-image. Mirrors proxy-webhook.js.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const serviceUrl = process.env.LOGO_COMPOSITE_SERVICE_URL;
  const secret = process.env.LOGO_COMPOSITE_SHARED_SECRET;
  if (!serviceUrl || !secret) {
    console.error('[watermark] LOGO_COMPOSITE_SERVICE_URL / LOGO_COMPOSITE_SHARED_SECRET not set');
    return respond(500, { error: 'Watermark service is not configured. Set LOGO_COMPOSITE_SERVICE_URL and LOGO_COMPOSITE_SHARED_SECRET in Netlify environment variables.' });
  }

  try {
    const res = await fetch(serviceUrl.replace(/\/+$/, '') + '/composite-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + secret,
      },
      body: event.body,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return respond(res.status, data);
  } catch (err) {
    console.error('[watermark] Upstream fetch failed:', err.message);
    return respond(502, { error: 'Watermark request failed', detail: err.message });
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

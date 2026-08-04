/**
 * reels — service-role access to reel_edls for studio-dash Reel Editor (D2 review + delivery).
 *
 * WHY THIS EXISTS: public.reel_edls is RLS deny-by-default (service_role bypasses).
 * The browser's anon key cannot read render_status/render_url nor set status='approved',
 * so all reel access is routed through this server-side function which holds the
 * service-role key + the WF2 webhook secret in Netlify env (never shipped to the client).
 *
 * Actions (POST body { action, ... }):
 *   list        { studio_id }            -> the studio's reels + render fields (trimmed edl: hook/clip_count/duration).
 *                                           Delivered reels' render_url is signed here (short-TTL); the compact row
 *                                           defers the <video> MOUNT to expand, so no video bytes are fetched while
 *                                           collapsed. (Signing at list keeps the response backward-compatible with any
 *                                           cached client — the server fn is always current — and avoids an async
 *                                           expand-sign path that broke playback for stale frontends.)
 *   sign_render { reel_id }              -> mint a short-TTL signed playback URL for a delivered reel (kept for
 *                                           on-demand use; the UI now reads the list-signed render_url directly).
 *   approve     { reel_id, hook_text? }  -> capture the reviewer's final hook into the EDL (overlays[0].text +
 *                                           approval.hook_edited) as the moat signal BEFORE render, flip
 *                                           pending_approval->approved (conditional), then fire the authenticated
 *                                           WF2 render webhook (x-wf2-secret). Renders nothing without the header.
 *
 * Track B: source clips (reel-sources) + renders (reel-renders) are private, studio-scoped. Fetchable URLs are
 * minted at use (WF1 sign-to-probe, WF2 sign-at-render, and here sign-at-load) — never baked into the DB.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fidhmvuurygpknhshpml.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WF2_URL = process.env.WF2_WEBHOOK_URL || 'https://jmac.app.n8n.cloud/webhook/wf2-render';
const WF2_SECRET = process.env.WF2_WEBHOOK_SECRET;
const RENDER_URL_TTL_S = 21600; // 6h — comfortable review window; re-minted on each list.

// Delivered reels hold a reel-renders storage path in render_url. Mint a signed URL for playback.
// Back-compat: a full http(s) URL (older rows) passes through unchanged; null/empty stays null.
async function signRenderUrl(val) {
  if (!val || /^https?:\/\//i.test(val)) return val || null;
  try {
    const res = await fetch(SUPABASE_URL + '/storage/v1/object/sign/reel-renders/' + val, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: RENDER_URL_TTL_S }),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({}));
    const signed = j.signedURL || j.signedUrl;
    return signed ? SUPABASE_URL + '/storage/v1' + signed : null;
  } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  if (!SERVICE_KEY) return respond(500, { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured. Set it in Netlify environment variables.' });

  // Require a valid Supabase session (authenticated user).
  const authz = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authz.replace(/^Bearer\s+/i, '').trim();
  if (!token) return respond(401, { error: 'Missing auth token' });
  const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
  });
  if (!userRes.ok) return respond(401, { error: 'Invalid or expired session' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return respond(400, { error: 'Invalid JSON' }); }

  const rest = (path, opts = {}) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });

  try {
    if (body.action === 'list') {
      if (!body.studio_id) return respond(400, { error: 'studio_id is required' });
      const r = await rest('reel_edls?studio_id=eq.' + encodeURIComponent(body.studio_id) +
        '&select=reel_id,studio_id,status,edl,render_status,render_url,render_id,render_submitted_at,created_at,updated_at&order=created_at.desc');
      const rows = await r.json();
      if (!Array.isArray(rows)) return respond(502, { error: 'reel_edls read failed', detail: rows });
      const reels = await Promise.all(rows.map(async (x) => ({
        reel_id: x.reel_id,
        studio_id: x.studio_id,
        status: x.status,
        render_status: x.render_status,
        render_url: await signRenderUrl(x.render_url),
        render_ready: x.render_status === 'delivered' && !!x.render_url,
        created_at: x.created_at,
        updated_at: x.updated_at,
        hook: x.edl && x.edl.overlays && x.edl.overlays[0] ? x.edl.overlays[0].text : null,
        clip_count: x.edl && Array.isArray(x.edl.timeline) ? x.edl.timeline.length : null,
        duration_s: x.edl && x.edl.output ? x.edl.output.target_duration_s : null,
        // validation carries checks + flags. The UI needs it to say WHY an assembly failed:
        // without it every validation_failed reel got one generic string, and that string
        // advised "a shorter target length" — which is what CAUSES avoidable_clip_reuse.
        // Flags embed payloads that came from the model or the vendor
        // (opus_call_error:<Anthropic message>, inout_oob:<clip_id>, timeline_gap@seq3).
        // The UI only prefix-matches to select hardcoded copy, so ship the KIND, not the
        // payload — no model- or vendor-authored string crosses to the browser.
        validation: x.edl && x.edl.validation ? {
          checks: x.edl.validation.checks || null,
          flags: Array.isArray(x.edl.validation.flags)
            ? x.edl.validation.flags.map((f) => String(f).split(/[:@]/)[0])
            : [],
        } : null,
      })));
      return respond(200, { reels });
    }

    if (body.action === 'sign_render') {
      if (!body.reel_id) return respond(400, { error: 'reel_id is required' });
      const r = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) + '&select=render_url,render_status&limit=1');
      const rows = await r.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return respond(404, { error: 'Reel not found' });
      const url = await signRenderUrl(row.render_url);
      return respond(200, { render_url: url });
    }

    if (body.action === 'approve') {
      if (!body.reel_id) return respond(400, { error: 'reel_id is required' });
      if (!WF2_SECRET) return respond(500, { error: 'WF2_WEBHOOK_SECRET is not configured. Set it in Netlify environment variables.' });

      // Fetch the pending EDL so we can fold the reviewer's final hook in as the moat signal.
      const cur = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) + '&status=eq.pending_approval&select=edl&limit=1');
      const curRows = await cur.json();
      const curRow = Array.isArray(curRows) ? curRows[0] : null;
      if (!curRow) return respond(409, { error: 'Reel is not in pending_approval state (already approved, rendering, or not found).' });

      const edl = curRow.edl || {};
      const overlays = Array.isArray(edl.overlays) ? edl.overlays : [];
      let hook_edited = !!(edl.approval && edl.approval.hook_edited);
      if (typeof body.hook_text === 'string' && overlays[0]) {
        const proposed = overlays[0].proposed_text != null ? overlays[0].proposed_text : overlays[0].text;
        const finalText = body.hook_text.trim();
        if (finalText) overlays[0].text = finalText;
        hook_edited = overlays[0].text !== proposed; // moat signal: did the studio change the wording?
      }
      edl.overlays = overlays;
      edl.approval = Object.assign({}, edl.approval, { hook_edited, approved_at: new Date().toISOString() });

      // Conditional flip + EDL update. If the row isn't still pending, 0 rows -> we do NOT fire (prevents
      // double-render / re-approve spend). WF2's Capture Insert records proposed vs final before the render.
      const patch = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) + '&status=eq.pending_approval', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'approved', edl }),
      });
      const updated = await patch.json();
      if (!Array.isArray(updated) || updated.length === 0) {
        return respond(409, { error: 'Reel is not in pending_approval state (already approved, rendering, or not found).' });
      }
      // Fire the authenticated WF2 render webhook. Secret lives only here (server-side).
      const wh = await fetch(WF2_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wf2-secret': WF2_SECRET },
        body: JSON.stringify({ reel_id: body.reel_id }),
      });
      const text = await wh.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return respond(200, { approved: true, reel_id: body.reel_id, hook_edited, webhook_status: wh.status, webhook: data });
    }

    return respond(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('[reels] error:', err.message);
    return respond(502, { error: 'Reels function error', detail: err.message });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': process.env.DASHBOARD_ORIGIN || 'https://studio-dash.netlify.app',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}
function respond(status, body) {
  return { statusCode: status, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

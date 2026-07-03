/**
 * reels — service-role access to reel_edls for studio-dash D2 (Reel Editor review).
 *
 * WHY THIS EXISTS: public.reel_edls is RLS deny-by-default (service_role bypasses).
 * The browser's anon key cannot read render_status/render_url nor set status='approved',
 * so all reel access is routed through this server-side function which holds the
 * service-role key + the WF2 webhook secret in Netlify env (never shipped to the client).
 *
 * Actions (POST body { action, ... }):
 *   list    { studio_id }            -> the studio's reels + render fields (trimmed edl: hook/clip_count/duration)
 *   approve { reel_id }              -> status pending_approval->approved (conditional), then fire the
 *                                        authenticated WF2 render webhook (x-wf2-secret). Renders nothing without the header.
 *
 * Backend contracts (WF1/WF2/reconciler + reel_edls schema) are LOCKED — this function only reads/writes
 * reel_edls.status and reads render_* fields, and calls the existing /wf2-render webhook. No schema/workflow change.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fidhmvuurygpknhshpml.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WF2_URL = process.env.WF2_WEBHOOK_URL || 'https://jmac.app.n8n.cloud/webhook/wf2-render';
const WF2_SECRET = process.env.WF2_WEBHOOK_SECRET;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  if (!SERVICE_KEY) return respond(500, { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured. Set it in Netlify environment variables.' });

  // Require a valid Supabase session (authenticated user). Beta note: does not yet verify the
  // user's membership of studio_id (single-studio beta) — tighten to per-studio authz before multi-tenant.
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
      const reels = rows.map((x) => ({
        reel_id: x.reel_id,
        studio_id: x.studio_id,
        status: x.status,
        render_status: x.render_status,
        render_url: x.render_url,
        created_at: x.created_at,
        updated_at: x.updated_at,
        hook: x.edl && x.edl.overlays && x.edl.overlays[0] ? x.edl.overlays[0].text : null,
        clip_count: x.edl && Array.isArray(x.edl.timeline) ? x.edl.timeline.length : null,
        duration_s: x.edl && x.edl.output ? x.edl.output.target_duration_s : null,
      }));
      return respond(200, { reels });
    }

    if (body.action === 'approve') {
      if (!body.reel_id) return respond(400, { error: 'reel_id is required' });
      if (!WF2_SECRET) return respond(500, { error: 'WF2_WEBHOOK_SECRET is not configured. Set it in Netlify environment variables.' });
      // Conditional approve: only flips pending_approval -> approved. If the row isn't pending,
      // 0 rows return -> we do NOT fire the webhook (prevents double-render / re-approve spend).
      const patch = await rest('reel_edls?reel_id=eq.' + encodeURIComponent(body.reel_id) + '&status=eq.pending_approval', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'approved' }),
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
      return respond(200, { approved: true, reel_id: body.reel_id, webhook_status: wh.status, webhook: data });
    }

    return respond(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('[reels] error:', err.message);
    return respond(502, { error: 'Reels function error', detail: err.message });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function respond(status, body) {
  return { statusCode: status, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

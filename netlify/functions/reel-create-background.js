/**
 * reel-create-background — B2 STEP 3: fire WF1 (Edit Planner) for a new self-serve reel.
 *
 * A Netlify BACKGROUND function (name ends in -background): returns 202 immediately and runs up to
 * 15 min, so it can wait on WF1's slow chain (sign -> probe -> Opus -> validate -> persist) without a
 * sync-function timeout. WF1 persists a pending_approval reel_edls row; the Reels list poll surfaces it.
 *
 * Holds WF1_WEBHOOK_SECRET server-side (never shipped to the client). Authz (defense in depth — the
 * reel-sources upload RLS is the primary, client-visible gate): the caller's session must be a member
 * of manifest.studio_id (parity with get_my_studio_ids = active instructor OR client), and every clip
 * path must live under {studio_id}/, so a client cannot make WF1 sign another studio's clips.
 *
 * Does NOT touch WF2 / approve / render — that stays on the Reels card (D2), Mac-gated.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fidhmvuurygpknhshpml.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WF1_URL = process.env.WF1_WEBHOOK_URL || 'https://jmac.app.n8n.cloud/webhook/fca/wf1-edit-planner';
const WF1_SECRET = process.env.WF1_WEBHOOK_SECRET;

const rest = (path, opts = {}) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
  ...opts,
  headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

// Membership parity with the reel-sources INSERT policy (get_my_studio_ids = active instructor OR client).
async function isStudioMember(email, studioId) {
  if (!email || !studioId) return false;
  const e = encodeURIComponent(email);
  const s = encodeURIComponent(studioId);
  const [insR, cliR] = await Promise.all([
    rest(`studio_instructors?studio_id=eq.${s}&instructor_email=eq.${e}&status=eq.active&select=id&limit=1`),
    rest(`clients?studio_id=eq.${s}&email=eq.${e}&select=id&limit=1`),
  ]);
  const ins = await insR.json().catch(() => []);
  const cli = await cliR.json().catch(() => []);
  return (Array.isArray(ins) && ins.length > 0) || (Array.isArray(cli) && cli.length > 0);
}

exports.handler = async (event) => {
  const done = (status, msg) => { if (status >= 400) console.error('[reel-create] ' + status + ': ' + msg); return { statusCode: status, body: msg }; };
  if (event.httpMethod !== 'POST') return done(405, 'method not allowed');
  if (!SERVICE_KEY) return done(500, 'SUPABASE_SERVICE_ROLE_KEY not configured');
  if (!WF1_SECRET) return done(500, 'WF1_WEBHOOK_SECRET not configured');

  const authz = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authz.replace(/^Bearer\s+/i, '').trim();
  if (!token) return done(401, 'missing auth token');
  const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token } });
  if (!userRes.ok) return done(401, 'invalid or expired session');
  const authUser = await userRes.json().catch(() => null);
  const email = authUser && authUser.email ? authUser.email : null;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return done(400, 'invalid JSON'); }
  const m = body.manifest || {};
  const clips = Array.isArray(m.source_clips) ? m.source_clips : [];
  if (!m.reel_id || !m.studio_id) return done(400, 'manifest requires reel_id and studio_id');
  if (!clips.length) return done(400, 'manifest requires at least one source clip');
  if (!clips.every((c) => c && typeof c.storage_path === 'string' && c.clip_id)) return done(400, 'each source_clip needs clip_id and storage_path');

  if (!(await isStudioMember(email, m.studio_id))) return done(403, 'session is not a member of this studio');
  const prefix = m.studio_id + '/';
  if (!clips.every((c) => c.storage_path.startsWith(prefix))) return done(400, 'clip paths must be under the studio folder');

  // Fire WF1 (awaited; background function has headroom). WF1 persists a pending_approval row.
  try {
    const wh = await fetch(WF1_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wf1-secret': WF1_SECRET },
      body: JSON.stringify(m),
    });
    const text = await wh.text();
    console.log('[reel-create] reel ' + m.reel_id + ' WF1 status=' + wh.status + ' body=' + text.slice(0, 300));
    return { statusCode: wh.ok ? 200 : 502, body: text.slice(0, 500) };
  } catch (err) {
    return done(502, 'WF1 fire failed: ' + err.message);
  }
};

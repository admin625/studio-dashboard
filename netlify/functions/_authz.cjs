/**
 * Shared authorization for Netlify functions.
 *
 * WHY THIS EXISTS
 * ---------------
 * The database already enforces tenancy correctly, and has since it was built. Every tenant
 * table carries RLS keyed on the caller's JWT email via get_my_studio_id[s]().
 *
 * A function that reads with SUPABASE_SERVICE_ROLE_KEY steps around all of it. service_role
 * bypasses RLS by design — that is what it is for. So the security model is not missing from
 * those functions, it is BYPASSED, and any new function that reaches for service_role
 * re-inherits the bypass by default. It then has to re-implement, by hand, what the database
 * was already doing for free.
 *
 * Evidence for that being the actual mechanism rather than a theory (2026-08-06 audit):
 *
 *   function                     service_role   caller-token   authz correct?
 *   generate-content.js               no            yes             yes
 *   proxy-webhook.js                  no            yes             yes
 *   reel-create-background.js         yes           yes             yes (hand-written)
 *   reels.js                          yes           no              NO
 *
 * Both functions that read as the caller got tenancy right for free. Both that read as
 * service_role had to hand-roll it, and one of them didn't. This module is that hand-rolling,
 * written once.
 *
 * USE THIS BY DEFAULT IN ANY NEW FUNCTION THAT TOUCHES TENANT DATA. It is not a patch applied
 * to old code; it is the pattern. If you are writing a function and have not called
 * requireStudioAccess, you have almost certainly inherited the bypass.
 *
 * PREFERRED ALTERNATIVE: if the function does not need privileged work (no held secret, no
 * signed-URL minting, no cross-tenant read), read with the CALLER'S token instead and let RLS
 * do the work. That deletes the problem rather than patching it. This module is for the cases
 * that genuinely need service_role.
 *
 * ROLE MODEL — derived from the RLS policies, not invented here:
 *   member  = active studio_instructor OR client of the studio   (parity: get_my_studio_ids)
 *   owner   = studio_accounts.owner_email matches the caller     (parity: sa_update_owner)
 *
 * Instructors are read-only on studio-level configuration and read-write on their own content:
 * they can view + generate + edit content for their studio, but cannot change Brand settings
 * (sa_update_owner is owner-only), cannot add/edit/delete photos (sp_* INSERT/UPDATE/DELETE use
 * get_my_studio_id(), which is clients-only), and cannot see billing (trials is owner-only).
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fidhmvuurygpknhshpml.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const svc = (path) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
  headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
});

/**
 * Resolve the caller's email from their Supabase session. Returns null if the token is
 * missing, malformed or expired — callers must treat null as 401 and stop.
 */
async function callerEmail(event) {
  const authz = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authz.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return null;
    const user = await res.json();
    const email = user && user.email ? String(user.email).trim() : '';
    return email || null;
  } catch { return null; }
}

/**
 * Is this caller a member of this studio? Parity with get_my_studio_ids(): an ACTIVE instructor
 * or a client row. Both halves are checked because the two tables express different things and
 * a studio owner is represented in `clients`, not `studio_instructors`.
 *
 * Email comparison is case-insensitive here on purpose. The RLS policies compare exactly, and
 * one capital letter is a known silent-lockout mode; being stricter than RLS would deny a user
 * the database would allow, which is a confusing failure rather than a safe one.
 */
async function isStudioMember(email, studioId) {
  if (!email || !studioId) return false;
  const e = encodeURIComponent(email.toLowerCase());
  const s = encodeURIComponent(studioId);
  try {
    const [insR, cliR] = await Promise.all([
      svc(`studio_instructors?select=studio_id&studio_id=eq.${s}&status=eq.active&instructor_email=ilike.${e}&limit=1`),
      svc(`clients?select=studio_id&studio_id=eq.${s}&email=ilike.${e}&limit=1`),
    ]);
    const [ins, cli] = await Promise.all([insR.json(), cliR.json()]);
    return (Array.isArray(ins) && ins.length > 0) || (Array.isArray(cli) && cli.length > 0);
  } catch { return false; }
}

/** Is this caller the studio's owner? Parity with the sa_update_owner policy. */
async function isStudioOwner(email, studioId) {
  if (!email || !studioId) return false;
  const e = encodeURIComponent(email.toLowerCase());
  const s = encodeURIComponent(studioId);
  try {
    const r = await svc(`studio_accounts?select=id&id=eq.${s}&owner_email=ilike.${e}&limit=1`);
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}

/**
 * The one call every tenant-touching handler should make.
 *
 *   const gate = await requireStudioAccess(event, studioId, 'member' | 'owner')
 *   if (!gate.ok) return respond(gate.status, { error: gate.error })
 *
 * `level` is REQUIRED and has no default on purpose: the author has to state whether this
 * endpoint is member-level or owner-level. A default would let the next endpoint be written
 * without the decision being made, which is how this gap appeared in the first place.
 */
async function requireStudioAccess(event, studioId, level) {
  if (level !== 'member' && level !== 'owner') {
    return { ok: false, status: 500, error: 'authz misconfigured: level must be "member" or "owner"' };
  }
  if (!SERVICE_KEY) {
    return { ok: false, status: 500, error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' };
  }
  if (!studioId) return { ok: false, status: 400, error: 'studio_id is required' };

  const email = await callerEmail(event);
  if (!email) return { ok: false, status: 401, error: 'Sign in again to continue.' };

  const allowed = level === 'owner'
    ? await isStudioOwner(email, studioId)
    : await isStudioMember(email, studioId);

  if (!allowed) {
    // Deliberately does not distinguish "studio does not exist" from "not yours" — that
    // difference is itself a cross-tenant disclosure.
    console.error('[authz] denied', level, 'for', email, 'on studio', studioId);
    return { ok: false, status: 403, error: 'You do not have access to that studio.' };
  }
  return { ok: true, email, studioId, level };
}

module.exports = { requireStudioAccess, isStudioMember, isStudioOwner, callerEmail };

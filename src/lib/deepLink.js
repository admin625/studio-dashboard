/**
 * Email deep-link handling, and the allowlist that guards the login round trip.
 *
 * WHY THIS EXISTS: delivery emails emit `/?id=<delivery_id>` — the route shape of
 * the retired vanilla SPA, which read it with URLSearchParams. The React rewrite
 * never read a query parameter, and `/` routes to `/deliveries`, so the id was
 * silently discarded and every studio arriving by email landed on the list
 * instead of their delivery. Neither side errored, which is why it went unseen.
 *
 * Fixed in the app rather than in the email template because weeks of already-sent
 * emails carry this URL shape. Only an app-side fix repairs those; changing the
 * template would repair future sends alone.
 *
 * ONE definition of the allowlist, imported by ProtectedRoute, Login and
 * AuthCallback. Three copies would drift — the repo already carries that hazard
 * with slug() in downloadUrl.js vs reels.cjs, and that pair at least has a stated
 * reason (module-format boundary). These three are all Vite-bundled ESM, so there
 * is no reason to duplicate.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Where anyone lands with no valid pending destination. */
export const DEFAULT_PATH = '/deliveries'

/** Key for the cross-document hop. See stashPendingPath below for why storage. */
const PENDING_KEY = 'fca_post_login_path'

/**
 * Static in-app destinations a login round trip may return to. Mirrors the
 * authenticated routes in App.jsx. `/login`, `/auth/callback` and
 * `/forgot-password` are deliberately absent — returning to them post-login is
 * either a loop or meaningless.
 */
const STATIC_PATHS = new Set([
  '/deliveries',
  '/photos',
  '/reels',
  '/reels/upload',
  '/brand',
  '/settings/account',
])

/**
 * Is this a destination we are willing to navigate to after login?
 *
 * ALLOWLIST, not sanitisation. The value reaches us from history state or session
 * storage, so it is attacker-influencable in principle; the safe posture is to
 * enumerate what is permitted rather than to try to strip what is not. Anything
 * unrecognised falls back to DEFAULT_PATH.
 *
 * Rejects absolute and protocol-relative URLs explicitly. `//evil.example` is a
 * valid protocol-relative URL that a naive `startsWith('/')` check accepts and a
 * browser resolves to a different origin — the classic open-redirect shape.
 */
export function isAllowedPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  if (!path.startsWith('/')) return false   // relative or absolute URL
  if (path.startsWith('//')) return false   // protocol-relative -> off-origin
  if (path.includes('\\')) return false     // backslash normalises to / in some parsers

  // Compare the path only; a query or fragment is not part of the decision.
  const clean = path.split('?')[0].split('#')[0]

  if (STATIC_PATHS.has(clean)) return true

  // The one dynamic route worth returning to, and the entire point of this file.
  if (clean.startsWith('/delivery/')) {
    return UUID_RE.test(clean.slice('/delivery/'.length))
  }

  return false
}

/** Allowlisted path, or the default. Never returns an unvetted value. */
export function safeRedirect(path) {
  return isAllowedPath(path) ? path : DEFAULT_PATH
}

/**
 * `/?id=<uuid>` -> `/delivery/<uuid>`, or null when there is nothing to do.
 *
 * UUID-validated before use because the value is interpolated into a URL path.
 * An unvalidated id would mount DeliveryView against garbage and surface a raw
 * PostgREST error; falling through to the list is today's behaviour and is the
 * right failure mode for a link we cannot make sense of.
 */
export function deliveryPathFromQuery(search) {
  let id
  try {
    id = new URLSearchParams(search || '').get('id')
  } catch {
    return null
  }
  if (!id) return null
  const trimmed = id.trim()
  return UUID_RE.test(trimmed) ? `/delivery/${trimmed}` : null
}

/**
 * Persist the intended destination across the login hop.
 *
 * React Router's `location.state` rides the History API, which survives in-app
 * navigation but NOT a fresh document load. A magic link leaves the app entirely
 * and returns to /auth/callback as a new document, so state alone would drop the
 * destination on exactly the path most email users take. sessionStorage survives
 * that, within the same tab.
 *
 * Storage can throw (Safari private mode, disabled storage). A failure here must
 * degrade to "land on the deliveries list", never to a broken login.
 */
export function stashPendingPath(path) {
  if (!isAllowedPath(path)) return
  try {
    window.sessionStorage.setItem(PENDING_KEY, path)
  } catch {
    /* no-op: falls back to DEFAULT_PATH */
  }
}

/** Read and clear the pending destination. Always returns an allowlisted path. */
export function takePendingPath() {
  let stored = null
  try {
    stored = window.sessionStorage.getItem(PENDING_KEY)
    window.sessionStorage.removeItem(PENDING_KEY)
  } catch {
    /* no-op */
  }
  return safeRedirect(stored)
}

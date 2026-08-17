/**
 * Email deep-link handling, and the allowlist that guards every post-login hop.
 *
 * WHY THIS EXISTS: delivery emails emit `/?id=<delivery_id>` — the route shape of
 * the retired vanilla SPA, which read it with URLSearchParams. The React rewrite
 * never read a query parameter, and `/` routes to `/deliveries`, so the id was
 * silently discarded and every studio arriving by email landed on the list
 * instead of their delivery. Neither side errored, which is why it went unseen.
 *
 * Fixed in the app rather than in the email template because weeks of already-sent
 * emails carry this URL shape. Only an app-side fix repairs those.
 *
 * THE DESTINATION RIDES IN THE URL, END TO END. An earlier version stashed it in
 * sessionStorage. That could not work for magic links: mail clients open a new
 * tab, sessionStorage is per-tab, and the stash was unreadable on the one path
 * that matters most — magic link is the primary sign-in method for studios. The
 * email itself demonstrated the better carrier, since `redirect_to` already
 * survives the whole GoTrue round trip intact. Verified 2026-08-17: a
 * query-bearing callback matches the `https://app.fiorsaoirse.com/**` allowlist
 * entry and `next` round-trips unmodified.
 *
 * ONE definition of the allowlist, imported by ProtectedRoute, Login,
 * ForgotPassword and AuthCallback. Three or four copies would drift, and drift in
 * a security check is how a hole opens quietly.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Where anyone lands with no valid destination. */
export const DEFAULT_PATH = '/deliveries'

/** The query parameter that carries the destination on every hop. */
const NEXT_PARAM = 'next'

/**
 * Static in-app destinations a login round trip may return to. Mirrors the
 * authenticated routes in App.jsx. `/login`, `/auth/callback` and
 * `/forgot-password` are deliberately absent — returning to them post-login is
 * either a loop or meaningless.
 *
 * ⚠️ Adding an authenticated route to App.jsx means adding it here too, or a
 * post-login return to it silently falls back to DEFAULT_PATH.
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
 * A PATH, NEVER A URL. Do not "add support for full URLs" — accepting an absolute
 * or protocol-relative URL here is exactly the open redirect this function exists
 * to prevent. If a future feature needs to send someone off-site, that belongs in
 * a separate, explicitly-named function with its own allowlist of hosts.
 *
 * ALLOWLIST, not sanitisation. Enumerate what is permitted rather than trying to
 * strip what is not; anything unrecognised falls back to DEFAULT_PATH.
 *
 * Rejects protocol-relative URLs explicitly. `//evil.example` is a valid URL that
 * a naive `startsWith('/')` check accepts and a browser resolves to a different
 * origin — the classic open-redirect shape.
 */
export function isAllowedPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  if (!path.startsWith('/')) return false   // relative, or an absolute URL with a scheme
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
 * UUID-validated because the value is interpolated into a URL path. An
 * unvalidated id would mount DeliveryView against garbage and surface a raw
 * PostgREST error; falling through to the list is the right failure mode for a
 * link we cannot make sense of.
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
 * Read the destination off a query string. THIS IS THE SECURITY BOUNDARY.
 *
 * `POST /auth/v1/otp` is reachable with the PUBLIC anon key, so anyone can mint a
 * genuine magic link for any existing studio owner carrying an arbitrary
 * `redirect_to` — including `/auth/callback?next=https://evil.example`. The victim
 * gets a real Supabase link, authenticates for real, and is then redirected
 * wherever `next` says.
 *
 * Which means validating when we WRITE the parameter is worthless: an attacker
 * never uses our write path. Read-side validation is the entire defense, and it
 * has to run at every point that consumes `next` — AuthCallback, Login,
 * ForgotPassword — with no exceptions and no "this one is internal" carve-outs.
 *
 * Fail-safe by construction: always returns a usable path, never null, so a caller
 * cannot forget a fallback and navigate somewhere undefined.
 */
export function nextPathFromQuery(search) {
  let raw
  try {
    raw = new URLSearchParams(search || '').get(NEXT_PARAM)
  } catch {
    return DEFAULT_PATH
  }
  return safeRedirect(raw)
}

/**
 * Attach the destination to an in-app hop: ProtectedRoute -> /login, and
 * /login -> /forgot-password. Without the second hop the destination dies when a
 * studio chooses the magic-link route, which is the majority path.
 *
 * Validated before it is written. That is not the defense — see
 * nextPathFromQuery — but there is no reason to emit a value we would refuse to
 * read back. Omits the parameter entirely for the default so ordinary logins keep
 * clean URLs.
 */
export function withNext(basePath, destination) {
  const dest = safeRedirect(destination)
  if (dest === DEFAULT_PATH) return basePath
  const params = new URLSearchParams()
  params.set(NEXT_PARAM, dest)
  return `${basePath}?${params.toString()}`
}

/**
 * Build the `emailRedirectTo` for a magic-link request.
 *
 * GoTrue carries this through the round trip and hands it back as the browser's
 * landing URL, which is how the destination survives a mail client opening a new
 * tab. URL + searchParams for encoding, never string concatenation — a hand-built
 * query string is how a `/` ends up read as a path separator somewhere downstream.
 */
export function buildCallbackUrl(origin, destination) {
  const url = new URL('/auth/callback', origin)
  const dest = safeRedirect(destination)
  if (dest !== DEFAULT_PATH) url.searchParams.set(NEXT_PARAM, dest)
  return url.toString()
}

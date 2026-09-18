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

import { isOwnerRole } from './role'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Where anyone lands with no valid destination. */
export const DEFAULT_PATH = '/deliveries'

/**
 * Where a STUDIO OWNER lands when the link carries no destination of its own.
 *
 * The plan is the owner's home. An owner arriving by magic link with nothing
 * specific to return to wants this week's slots, not the delivery list — the
 * calendar is the surface the co-design loop runs on.
 *
 * NOT a permission. `/calendar` is owner-gated server-side (the calendar function
 * gates at level 'owner', and calendar RLS keys on owned_studio_ids()), and Layout
 * already hides the tab from instructors. This constant only decides where a
 * browser is pointed; sending the wrong role here would show them an error, not
 * another studio's plan. Role is read from the signed access token — see
 * landingPath.
 */
export const OWNER_DEFAULT_PATH = '/calendar'

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
 *
 * 🚨 `/reels/upload` IS DELIBERATELY ABSENT, and is the one entry whose omission is
 * the point rather than an oversight. It is an unlinked private-beta surface that
 * renders an RLS self-test button, a raw studio id and a reel id to whoever opens
 * it. Until that debug furniture is gated (HQ item 3, 2026-09-18) nothing may
 * deep-link a studio into it — and a post-login landing is a deep link, arriving on
 * a session that just authenticated for real.
 *
 * This is also the 2026-09-18 blocker-1 fix. The route being allowlisted is what let
 * a bounce off `/reels/upload` mint `?next=/reels/upload`, ride the whole GoTrue
 * round trip, and put a rehearsal on the debug page instead of the calendar. The
 * redirect machinery was working exactly as designed; the destination was the bug.
 * With the entry gone, that bounce carries no destination at all and the login falls
 * through to landingPath's role default.
 *
 * ⚠️ Re-adding this line silently reopens both. Gate the page first.
 */
const STATIC_PATHS = new Set([
  '/deliveries',
  '/photos',
  '/reels',
  '/brand',
  '/calendar',
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
  return allowedNextOrNull(search) ?? DEFAULT_PATH
}

/**
 * The same read, the same allowlist, but able to say "there wasn't one".
 *
 * nextPathFromQuery collapses "absent" and "rejected" into DEFAULT_PATH, which is
 * the right shape for a caller that just needs somewhere to go — it cannot forget a
 * fallback. landingPath needs the distinction: no usable `next` is what licenses the
 * role default, and an explicit `next` must still win.
 *
 * ONE validation path. nextPathFromQuery is implemented on top of this rather than
 * beside it, so there is no second place for the allowlist to be applied — or
 * skipped. A rejected value returns null here and therefore falls through to a
 * default; it is never handed back to a caller, and never navigated to.
 */
export function allowedNextOrNull(search) {
  let raw
  try {
    raw = new URLSearchParams(search || '').get(NEXT_PARAM)
  } catch {
    return null
  }
  return isAllowedPath(raw) ? raw : null
}

/**
 * Where this login round trip should land: the ONE place that answers that question.
 *
 * Precedence, and the reason for it:
 *   1. An allowlisted `?next=` — the studio asked for somewhere specific (a delivery
 *      deep link from an email is the case this whole file exists for). An explicit
 *      destination always beats a default.
 *   2. The owner default, `/calendar` — an owner with nothing to return to.
 *   3. DEFAULT_PATH — everyone else, and anyone whose role we cannot read.
 *
 * `role` IS READ FROM THE SIGNED ACCESS TOKEN, NOT FROM APP STATE. AppContext's
 * `role` is populated by AuthProvider, which may still be resolving (or may have hit
 * its 10s safety valve, which sets authReady alone with nothing else). Gating this
 * on app state would make the landing page a race — and a race that loses silently,
 * by sending the owner to the default as though she had no role at all. The claim is
 * on the session the caller already holds, so there is nothing to wait for.
 *
 * FAIL-SAFE, like every other function here: an unknown, absent or unreadable role
 * yields DEFAULT_PATH. A studio never ends up somewhere undefined.
 *
 * ⚠️ Accounts provisioned without `raw_app_meta_data.role` have no claim to read and
 * will land on DEFAULT_PATH. That is the correct failure direction, but it means
 * this default is only as good as provisioning — see provision_studio().
 */
export function landingPath(search, role) {
  const explicit = allowedNextOrNull(search)
  if (explicit) return explicit
  return isOwnerRole(role) ? OWNER_DEFAULT_PATH : DEFAULT_PATH
}

/**
 * Attach the destination to an in-app hop: ProtectedRoute -> /login, and
 * /login -> /forgot-password. Without the second hop the destination dies when a
 * studio chooses the magic-link route, which is the majority path.
 *
 * Validated before it is written. That is not the defense — see
 * nextPathFromQuery — but there is no reason to emit a value we would refuse to
 * read back.
 *
 * 🚨 OMITS THE PARAMETER WHEN THERE IS NO VALID DESTINATION — *not* when the
 * destination happens to equal DEFAULT_PATH.
 *
 * It used to do the latter, and that was correct only for as long as DEFAULT_PATH
 * was also where everyone landed with no `next`. The moment the landing became
 * role-dependent (landingPath, 2026-09-18) the two stopped meaning the same thing,
 * and using one as a stand-in for the other silently ATE A REAL DESTINATION: an
 * owner bounced off `/deliveries` got a bare `/login`, carried nothing through the
 * round trip, and was delivered to `/calendar` — not the page she had asked for.
 * Verified by reproduction before this was changed.
 *
 * So the sentinel for "nothing to carry" is now the absence of a valid path, which
 * is what it always should have been. `/deliveries` is a destination like any other
 * and rides the URL when it was genuinely requested. Ordinary logins still keep
 * clean URLs, because a caller with no destination passes null — see Login.jsx and
 * ForgotPassword.jsx, which use allowedNextOrNull rather than laundering "absent"
 * into DEFAULT_PATH.
 */
export function withNext(basePath, destination) {
  if (!isAllowedPath(destination)) return basePath
  const params = new URLSearchParams()
  params.set(NEXT_PARAM, destination)
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
  // Same sentinel correction as withNext: carry any VALID destination, including
  // `/deliveries`, and omit only when there is none. Treating DEFAULT_PATH as "no
  // destination" here dropped it on the last hop, where it is least recoverable —
  // once the email is sent, the link is fixed.
  if (isAllowedPath(destination)) url.searchParams.set(NEXT_PARAM, destination)
  return url.toString()
}

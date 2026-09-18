/**
 * The role vocabulary bridge, in ONE place.
 *
 * The access token carries `app_metadata.role` as 'studio_owner' or 'instructor'.
 * The app gates on 'studio_owner' / 'studio_instructor'. Those two vocabularies are
 * one word apart, which is exactly the kind of gap that a second copy closes wrongly
 * and quietly — an `=== 'instructor'` written against the app's vocabulary is never
 * true and never errors.
 *
 * This lived as a private function inside AuthProvider until 2026-09-18, when the
 * post-login landing decision needed the same mapping. It moved here rather than
 * being copied, for the same reason lib/deepLink.js keeps exactly one allowlist:
 * a check that exists twice drifts, and a role check that drifts fails open in
 * whichever direction nobody tested.
 *
 * ⚠️ NOT AN AUTHORIZATION BOUNDARY. These read an unverified client-side copy of a
 * claim and answer "what should this browser show / where should it go". Every
 * actual permission is enforced server-side — `_authz.cjs requireStudioAccess` and
 * RLS. Do not add a caller that grants access on the strength of these.
 */

/**
 * JWT role -> the app's internal vocabulary.
 * Anything else (individual / unknown / absent) returns null so callers fall through
 * to their own resolution — a table lookup in AuthProvider, a default elsewhere.
 */
export function normalizeRole(r) {
  if (r === 'studio_owner') return 'studio_owner'
  if (r === 'instructor' || r === 'studio_instructor') return 'studio_instructor'
  return null
}

/**
 * Is this a studio owner? Accepts either vocabulary, so a caller holding a raw JWT
 * claim and a caller holding an already-normalized app role get the same answer
 * without having to know which one they have.
 *
 * Deliberately total: null, undefined, a number, a misspelling and an instructor all
 * return false. There is no throw and no "unknown" — a caller choosing where to send
 * someone must always get a usable boolean.
 */
export function isOwnerRole(r) {
  return normalizeRole(r) === 'studio_owner'
}

/**
 * The owner role as carried on a Supabase session, without a round trip.
 *
 * Reads `app_metadata.role` off the user object the session already contains. The
 * token is signed and was just minted by GoTrue; this is a read of data in hand, not
 * a decision to trust the client — see the boundary note above.
 */
export function roleFromSession(session) {
  return normalizeRole(session?.user?.app_metadata?.role)
}

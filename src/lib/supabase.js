import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
  || 'https://fidhmvuurygpknhshpml.supabase.co'

const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpZGhtdnV1cnlncGtuaHNocG1sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NDU4NjIsImV4cCI6MjA5MjAyMTg2Mn0.P2BZzkzPpTzUqWHdC9b0t_howmwHrNIr71ujMaT6aXM'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
export { SUPABASE_URL }

/**
 * ONE getSession() at a time, shared by every caller.
 *
 * WHY. supabase-js guards the persisted session with a lock (`lock:sb-<ref>-auth-token`) and
 * resolves contention by letting a later request STEAL it from an earlier one. The loser
 * rejects with:
 *
 *   Lock "lock:sb-<ref>-auth-token" was released because another request stole it
 *
 * On a first authenticated load this app used to put three or more claimants on that lock in
 * the same tick — `createClient()`'s own initialise (which also parses the magic-link fragment),
 * AuthProvider's restore, and whatever the landing route fetches. Measured on production
 * 2026-09-10, ten hard reloads of /deliveries: getSession timed out 10/10, the studio_accounts
 * read hit its 15s client ceiling 10/10, and the studio sat on a spinner 10/10. The database was
 * never involved — the same row read is an 0.087 ms index scan.
 *
 * De-duplicating the CALLS is what removes the contention. This is single-flight, not a cache:
 * concurrent callers share one in-flight promise, and the moment it settles the slot is cleared
 * so the next call reads fresh. Caching the RESULT would be a different and worse bug — a stale
 * access token surviving a sign-out, a refresh, or an account switch.
 *
 * USE THIS INSTEAD OF supabase.auth.getSession() EVERYWHERE. A direct call re-introduces exactly
 * one more claimant, which is all it took.
 */
let inFlightSession = null

export function getSessionOnce() {
  if (inFlightSession) return inFlightSession
  inFlightSession = supabase.auth.getSession()
  // Clear on settle, success or failure. Attached to a copy so the promise handed to callers
  // is the original — a `.finally()` chain would swallow nothing but would change identity.
  inFlightSession.then(
    () => { inFlightSession = null },
    () => { inFlightSession = null },
  )
  return inFlightSession
}

/**
 * Headers for calls to our own Netlify functions, which verify the Supabase
 * session and check the caller owns the studio named in the body.
 * Returns null when there is no live session so callers can say so plainly
 * rather than being rejected server-side with no explanation.
 */
export async function authedJsonHeaders() {
  const { data: { session } } = await getSessionOnce()
  if (!session?.access_token) return null
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
  }
}

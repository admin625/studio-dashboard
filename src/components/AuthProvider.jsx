/**
 * AuthProvider — runs session restore on mount, sets authReady.
 * Must wrap all routes so auth state is available everywhere.
 *
 * ⚠️ THE SESSION READ IS NO LONGER TIMED OUT, DELIBERATELY. It used to be wrapped in
 * `withTimeout(…, 5000)`, and `withTimeout` races a promise without cancelling the underlying
 * work — so a slow `getSession()` was abandoned by its caller while its lock request stayed
 * queued, and the retry stacked another one behind it. The timeout was manufacturing the
 * contention it existed to survive. supabase-js `getSession()` takes no AbortSignal, so there is
 * no way to bound it that actually cancels; the honest options are "no timeout" or "a timeout
 * that lies", and this is the first. The 10s valve below still guarantees the app renders.
 *
 * ⚠️ THE studio_accounts READ IS ABORTABLE AND SEQUENCED. It used to use `retryWithTimeout`,
 * which has the same non-cancelling behaviour, and once getSession was fixed that became the
 * dominant claimant — measured `attempts=2 elapsed≈15s` on 10 of 10 reloads. It is now a single
 * attempt bound by a real `AbortController` via `.abortSignal()`, retried at most once and only
 * after the first abort has actually fired. It also starts strictly after `getSessionOnce()`
 * resolves, so AuthProvider never puts two claimants on the auth-token lock in one tick.
 */
import { useEffect, useRef, useCallback, useState } from 'react'
import { useLocation, Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { supabase, getSessionOnce } from '../lib/supabase'
// Still used by lookupUserRole's studio_instructors/clients reads. Those run on the fallback
// path only (no JWT studio claim), not on the first-load contention path.
import { withTimeout } from '../lib/withTimeout'
import { classifyStudioLoadError, describeStudioLoadFailure, STUDIO_LOAD_TIMEOUT, STUDIO_LOAD_NO_ROW } from '../lib/studioLoadDiagnostics'
import { useApp } from '../context/AppContext'

// Default brand colors — match :root in index.css
const DEFAULT_BRAND_PRIMARY = '#667eea'
const DEFAULT_BRAND_SECONDARY = '#764ba2'

/**
 * Write the studio's brand colors to CSS custom properties on <html>.
 * Every component (React or raw CSS) can then read them via
 * var(--brand-primary) / var(--brand-secondary). Passing null/empty
 * resets to the default purple.
 */
function applyBrandColors(primary, secondary) {
  const root = document.documentElement
  root.style.setProperty('--brand-primary', primary || DEFAULT_BRAND_PRIMARY)
  root.style.setProperty('--brand-secondary', secondary || DEFAULT_BRAND_SECONDARY)
}

/**
 * Normalize the JWT app_metadata role into the app's internal vocabulary.
 * The access token carries 'studio_owner' or 'instructor'; the app gates on
 * 'studio_owner' / 'studio_instructor'. Anything else (individual/unknown/absent)
 * returns null so resolution falls through to the table lookup.
 */
function normalizeRole(r) {
  if (r === 'studio_owner') return 'studio_owner'
  if (r === 'instructor' || r === 'studio_instructor') return 'studio_instructor'
  return null
}

/**
 * Read a single claim from a JWT without verifying it (client-side read only).
 * The server-side custom_access_token_hook injects `fca_studio_id` for studio
 * sessions; mirrors the decoder already used in ReelUpload.
 */
function decodeJwtClaim(token, key) {
  try {
    const part = token.split('.')[1]
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)[key] ?? null
  } catch {
    return null
  }
}

// Hardcoded admin accounts — bypass the ROLE/SCOPE lookup only.
//
// ⚠️ DO NOT reintroduce a `studioData` key here. It used to bake brand fields in and skip the
// studio_accounts query entirely, which meant the admin session rendered a correct-looking role
// and studio name from literals while brand_font, brand_voice, brand_color_secondary,
// studio_type, is_beta and all three logo URLs showed blank — every one of them populated in the
// database the whole time.
//
// That was a data-loss path, not a display bug. BrandSettings seeds its form state from this
// context and saves what it displays, and its own guard (authReady + studioLoadError) is
// satisfied by construction when the values are baked — so the guard that exists precisely to
// stop defaults overwriting stored values could not see the blanks coming through it.
//
// The bypass exists to skip the slow, timeout-prone role lookup. studioId is known right here,
// so the normal studio_accounts query works fine and admin now reads real brand data like every
// other account.
const ADMIN_ACCOUNTS = {
  'admin@fiorsaoirse.com': {
    role: 'studio_owner',
    studioId: '085fde09-d7f7-486f-89d6-d65fc1838ab0',
    clientId: 'f896e176-ee81-4a7f-9414-500caba002fd',
    scopeType: 'studio',
  },
}

/** Routes that must render even when the session cannot be read. /login is the way out. */
const PUBLIC_PATHS = new Set(['/login', '/auth/callback', '/forgot-password'])

/**
 * Shown when the session read has not resolved — a stall, not a sign-out.
 *
 * This is the screen that replaces a wrong answer. Before it existed, ten seconds of silence
 * became a redirect to /login, which tells a signed-in studio their session ended when it had
 * not. Waiting is recoverable; being ejected mid-work is not.
 */
function StillConnecting({ onRetry }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#0A0B0D' }}>
      <div className="text-center max-w-sm">
        <Loader2 size={28} className="animate-spin mx-auto mb-4" style={{ color: 'var(--brand-primary)' }} />
        <p className="text-slate-200 text-sm mb-2">Still connecting…</p>
        <p className="text-slate-500 text-xs leading-relaxed mb-6">
          This is taking longer than usual. You are still signed in — nothing has been lost.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="px-4 py-2 rounded-lg text-xs font-semibold text-white transition-opacity hover:opacity-90"
          style={{ background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-secondary) 100%)' }}
        >
          Try again
        </button>
        <p className="text-slate-600 text-xs mt-6">
          <Link to="/login" style={{ color: 'var(--brand-primary)' }}>Sign in instead</Link>
        </p>
      </div>
    </div>
  )
}

export default function AuthProvider({ children }) {
  const app = useApp()
  const location = useLocation()
  const initialized = useRef(false)
  const valveRef = useRef(null)
  const initInFlight = useRef(null)
  // setTimeout ids for work deferred out of the auth-lock callback; cleared on unmount.
  const deferredRefs = useRef([])
  // Distinct from "no session". True means we could not READ the session, not that there is none.
  const [authUnresolved, setAuthUnresolved] = useState(false)

  const lookupUserRole = useCallback(async (email) => {
    // Admin bypass — no queries, no timeouts, instant access
    if (ADMIN_ACCOUNTS[email]) {
      return ADMIN_ACCOUNTS[email]
    }

    try {
      const { data: instr } = await withTimeout(
        supabase.from('studio_instructors').select('id, studio_id').eq('instructor_email', email).eq('status', 'active').limit(1).maybeSingle(),
        5000, 'studio_instructors'
      )
      if (instr) return { role: 'studio_instructor', studioId: instr.studio_id, clientId: null, scopeType: 'studio' }

      const { data: client } = await withTimeout(
        supabase.from('clients').select('id, email, studio_id, is_studio_instructor').eq('email', email).maybeSingle(),
        5000, 'clients'
      )
      if (client?.studio_id) return { role: 'studio_owner', studioId: client.studio_id, clientId: client.id, scopeType: 'studio' }
      if (client) return { role: 'individual', studioId: null, clientId: client.id, scopeType: 'individual' }
      return null
    } catch (err) {
      console.error('[FCA] lookupUserRole error:', err.message)
      return null
    }
  }, [])

  const initWithUser = useCallback(async (session) => {
    const user = session.user
    try {
      // 2a — Resolve role + studio scope from the JWT rather than the
      // timeout-prone studio_instructors/clients lookup. The access token
      // carries app_metadata.role and (via custom_access_token_hook) the
      // fca_studio_id claim, so studio sessions resolve synchronously and can
      // never be left with a null role/scope by a slow or timed-out query —
      // the root cause of the owner-only-UI and delivery-access races.
      // Admins keep their existing bypass; individual-scope and legacy sessions
      // (no fca_studio_id claim) fall back to the table lookup, which also
      // supplies the resolvedClientId used by the individual client_id leg.
      const isAdmin = !!ADMIN_ACCOUNTS[user.email]
      const jwtRole = normalizeRole(user.app_metadata?.role)
      const claimStudioId = decodeJwtClaim(session.access_token, 'fca_studio_id')

      let ri
      if (!isAdmin && jwtRole && claimStudioId) {
        ri = { role: jwtRole, studioId: claimStudioId, clientId: null, scopeType: 'studio' }
      } else {
        ri = await lookupUserRole(user.email)
        // Prefer the JWT role even on the fallback path (studioId still from lookup).
        if (!isAdmin && jwtRole && ri) ri = { ...ri, role: jwtRole }
      }

      const updates = {
        user, email: user.email,
        role: ri?.role || null,
        scopeType: ri?.scopeType || null,
        resolvedStudioId: ri?.studioId || null,
        resolvedClientId: ri?.clientId || null,
        authReady: true,
        studioLoadError: false,
        // No studio to load is a loaded state. Overwritten below for studio sessions.
        studioLoaded: true,
        studioLoadRetried: false,
      }

      // Every studio session — admin included — loads its brand from studio_accounts. There is
      // no baked-data branch: see the note on ADMIN_ACCOUNTS above for why it was removed.
      if (ri?.studioId) {
        updates.studioLoaded = false
        const studioLoadStartedAt = Date.now()
        let studioAttempts = 1
        try {
          // ONE ATTEMPT AT A TIME, AND IT IS REALLY CANCELLED WHEN IT GIVES UP.
          //
          // This used to be `retryWithTimeout(..., ceilings: [5000, 8000])`, which races a
          // promise and abandons the loser WITHOUT cancelling it. That is the same defect that
          // was removed from getSession, and after getSession was fixed it became the dominant
          // one: attempt 1 kept its place in the auth-token lock queue while attempt 2 queued
          // behind it, so a read that should cost one lock acquisition cost two and neither
          // could win. Measured 2026-09-10 across ten reloads — `attempts=2 elapsed≈15s`, 10/10,
          // while the row itself is an 0.087 ms index scan.
          //
          // `.abortSignal()` is the difference: supabase-js hands it to fetch, so an expired
          // ceiling tears the request down and releases its claim instead of leaving a ghost.
          // A second attempt is allowed ONLY once attempt 1's abort has actually fired, so the
          // two can never be in flight together. Two attempts maximum.
          const runAttempt = async () => {
            const controller = new AbortController()
            let aborted = false
            const ceiling = setTimeout(() => { aborted = true; controller.abort() }, 8000)
            try {
              const res = await supabase.from('studio_accounts')
                .select('studio_name, photo_source, ai_photo_prompt, brand_color, brand_color_secondary, brand_font, brand_voice, logo_url, logo_light_url, logo_dark_url, watermark_default_zone, watermark_default_variant, is_beta, studio_type, last_content_types')
                .eq('id', ri.studioId)
                .abortSignal(controller.signal)
                .single()
              return { ...res, aborted }
            } catch (e) {
              return { data: null, error: e, aborted }
            } finally {
              clearTimeout(ceiling)
            }
          }

          let attempt = await runAttempt()

          // Retry ONLY on a fired abort. A PostgREST error (RLS denial, no row, bad column) is
          // a real answer and repeating it just burns another lock acquisition for the same no.
          if (attempt.error && attempt.aborted) {
            studioAttempts = 2
            updates.studioLoadRetried = true
            console.warn('[FCA] studio_accounts attempt 1 ABORTED at its 8000ms ceiling and is cancelled, not merely abandoned — starting attempt 2.')
            attempt = await runAttempt()
          }

          const { data: s, error: qErr } = attempt
          if (qErr) throw qErr
          if (s) {
            Object.assign(updates, {
              studioName: s.studio_name || '',
              photoSource: s.photo_source || 'studio_only',
              aiPhotoPrompt: s.ai_photo_prompt || '',
              brandColorPrimary: s.brand_color || '',
              brandColorSecondary: s.brand_color_secondary || '',
              brandFont: s.brand_font || '',
              brandVoice: s.brand_voice || '',
              brandLogoUrl: s.logo_url || '',
              brandLogoLightUrl: s.logo_light_url || '',
              brandLogoDarkUrl: s.logo_dark_url || '',
              watermarkDefaultZone: s.watermark_default_zone || 'bottom-right',
              watermarkDefaultVariant: s.watermark_default_variant || 'auto',
              isBeta: s.is_beta || false,
              studioType: s.studio_type || '',
              lastContentTypes: s.last_content_types || [],
            })
            applyBrandColors(s.brand_color, s.brand_color_secondary)
            updates.studioLoaded = true
            // Log the SUCCESS latency too. Without it there is no distribution to
            // judge the 5000ms ceiling against, and any argument about the right
            // timeout is guesswork about a number nobody has ever seen.
            updates.studioLoadMs = Date.now() - studioLoadStartedAt
            console.info(`[FCA] studio_accounts OK in ${updates.studioLoadMs}ms (attempts=${studioAttempts})`)
          } else {
            // Defensive: .single() normally reports zero rows as PGRST116 rather
            // than data:null, so this branch is unusual — classify it the same way.
            const elapsedMs = Date.now() - studioLoadStartedAt
            updates.studioLoadError = true
            updates.studioLoadFailure = { kind: STUDIO_LOAD_NO_ROW, attempts: studioAttempts, elapsedMs, code: null }
            console.error(describeStudioLoadFailure(STUDIO_LOAD_NO_ROW, { attempts: studioAttempts, elapsedMs }))
          }
        } catch (e) {
          // A client abort and a real database failure used to print the same
          // string, so neither could be counted. They are now separate kinds with
          // separate messages, and the attempt count is what actually happened —
          // a PostgREST error is thrown after ONE attempt and must not be
          // reported as "after 2 attempts".
          const kind = classifyStudioLoadError(e)
          const elapsedMs = e?.elapsedMs ?? (Date.now() - studioLoadStartedAt)
          const attempts = e?.attempts ?? studioAttempts
          updates.studioLoadError = true
          updates.studioLoadFailure = { kind, attempts, elapsedMs, code: e?.code ?? null }
          const line = describeStudioLoadFailure(kind, { attempts, elapsedMs, code: e?.code, message: e?.message })
          if (kind === STUDIO_LOAD_TIMEOUT) console.warn(line)
          else console.error(line)
        }
      }

      app.update(updates)
    } catch (err) {
      console.error('[FCA] initWithUser fatal error:', err)
      app.update({ authReady: true })
    }
  }, [app, lookupUserRole])

  /**
   * One initWithUser at a time. A second caller joins the first rather than starting a
   * competing studio_accounts read — two reads in one tick is the contention this exists to
   * stop, and it is what INITIAL_SESSION arriving mid-restore used to cause.
   */
  const initOnce = useCallback((session) => {
    if (initInFlight.current) return initInFlight.current
    const p = initWithUser(session).finally(() => { initInFlight.current = null })
    initInFlight.current = p
    return p
  }, [initWithUser])

  const runRestore = useCallback(async () => {
    // 🚨 authUnresolved is NOT cleared here. It used to be, and that was the retry button's
    // ejection: by the time anyone presses "Try again" the valve has already set
    // `authReady: true` while `user` is still null, so dropping the connecting screen before
    // the new read has an answer hands ProtectedRoute exactly the pair it reads as logged-out,
    // and it redirects to /login before getSession has even been called. Same class as the
    // valve bounce this file already removed once. It is cleared below, on an ANSWER only.
    if (valveRef.current) clearTimeout(valveRef.current)

    // Safety valve: if the restore has not finished within 10s, let the app render rather than
    // hang. It deliberately does NOT set studioLoaded — the brand fields are still absent, and
    // with the retry the studio_accounts read can legitimately still be in flight at 10s.
    //
    // 🚨 WHAT IT MUST NOT DO IS SIGN ANYONE OUT. It used to set `authReady: true` with `user`
    // still null, and ProtectedRoute reads exactly that pair as "logged out" and redirects to
    // /login. So a ten-second stall — a contended lock, a slow network — presented as a session
    // that had ended. Failing to READ a session is not evidence that there is no session, and a
    // studio being bounced to a login screen mid-work is a far worse answer than being told to
    // wait. `authUnresolved` keeps the two apart.
    valveRef.current = setTimeout(() => {
      console.warn('[FCA] SAFETY VALVE: auth restore unresolved after 10s — rendering the connecting state, NOT signing out')
      setAuthUnresolved(true)
      app.update({ authReady: true })
    }, 10000)

    try {
      const { data: { session } } = await getSessionOnce()
      if (session?.user) {
        // Sequenced: the studio_accounts read inside initWithUser starts only now, after
        // getSessionOnce() has resolved. Never in the same tick as the session read.
        await initOnce(session)
      } else {
        // A definitive answer: there is no session. This is the ONLY path that may fall
        // through to the login redirect.
        app.update({ authReady: true })
      }
      setAuthUnresolved(false)
    } catch (err) {
      // A transport or lock failure. Not a definitive "no session" — see above.
      console.error('[FCA] restoreSession error:', (err && err.message) || err)
      app.update({ authReady: true })
      setAuthUnresolved(true)
    } finally {
      if (valveRef.current) clearTimeout(valveRef.current)
    }
  }, [app, initOnce])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    let mounted = true
    runRestore()

    // 🚨 THIS CALLBACK IS SYNCHRONOUS AND MAKES NO SUPABASE CALL. BOTH PROPERTIES ARE LOAD-BEARING.
    //
    // GoTrue invokes subscribers from INSIDE the auth-token lock and awaits what they return. So
    // a callback that awaits any supabase call deadlocks by construction: the call queues for a
    // lock that the callback itself is preventing from being released. Ours awaited
    // `initOnce(session)` → `.from('studio_accounts')` → `_acquireLock`, and the outcome was
    // exact — on a fresh password sign-in the network showed
    // `token?grant_type=password` 200 in 156 ms and then NOTHING: no studio_accounts request, no
    // pending request at all, button stuck on "Signing in…". The read was never issued. The lock
    // sat held, exclusive, zero pending, indefinitely. Confirmed by the ABSENCE of the request.
    //
    // The documented fix, and the one supabase-js uses on itself (see its own
    // `setTimeout(async () => this._notifyAllSubscribers('SIGNED_IN', session), 0)` inside
    // `_initialize`): set React state synchronously here, and push every supabase call onto a
    // later macrotask so it runs after the lock has been released.
    //
    // Do NOT make this `async` again, and do NOT `await` in it. queueMicrotask is not a
    // substitute either — a microtask still runs before the lock-holding frame unwinds.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return

      // INITIAL_SESSION is deliberately not handled: supabase-js fires it from inside its own
      // _initialize(), while runRestore() is already awaiting getSessionOnce(). Handling it
      // meant two initWithUser calls in one tick, each issuing its own studio_accounts read.
      if (event === 'SIGNED_IN' && session?.user) {
        const deferred = setTimeout(() => {
          if (!mounted) return
          // Out of the lock now. Safe to touch supabase.
          initOnce(session).then(() => {
            if (!mounted) return
            // Cleared only once the user is actually in context. Clearing it earlier would drop
            // the connecting screen while `user` is still null and `authReady` already true,
            // which ProtectedRoute reads as logged-out and answers with /login.
            setAuthUnresolved(false)
            if (valveRef.current) clearTimeout(valveRef.current)
          })
        }, 0)
        deferredRefs.current.push(deferred)
      } else if (event === 'SIGNED_OUT') {
        // Synchronous only — no supabase call, nothing awaited.
        app.reset()
        app.update({ authReady: true })
        setAuthUnresolved(false)
        applyBrandColors(null, null)
        if (valveRef.current) clearTimeout(valveRef.current)
      }
    })

    return () => {
      mounted = false
      if (valveRef.current) clearTimeout(valveRef.current)
      deferredRefs.current.forEach(clearTimeout)
      deferredRefs.current = []
      subscription?.unsubscribe()
    }
  }, []) // eslint-disable-line

  // Public routes must keep working even while auth is unresolved — /login is the way out of
  // this state, and /auth/callback has a magic-link token to process that does not depend on
  // any prior session.
  const onPublicRoute = PUBLIC_PATHS.has(location.pathname)

  if (authUnresolved && !app.user && !onPublicRoute) {
    return <StillConnecting onRetry={runRestore} />
  }

  return children
}

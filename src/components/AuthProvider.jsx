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
 * The studio_accounts read keeps its `retryWithTimeout` — that one is a PostgREST fetch, its
 * abandonment costs a socket rather than a lock slot, and it is not on the contention path.
 */
import { useEffect, useRef, useCallback, useState } from 'react'
import { useLocation, Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { supabase, getSessionOnce } from '../lib/supabase'
// Still used by lookupUserRole's studio_instructors/clients reads. Those are PostgREST
// fetches, not getSession — abandoning one costs a socket, not a place in the auth-lock
// queue — so bounding them is safe in a way that bounding getSession was not.
import { withTimeout } from '../lib/withTimeout'
import { retryWithTimeout } from '../lib/retryWithTimeout'
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
          // Retry once with a higher ceiling rather than one longer wait: a longer
          // single timeout trades a fast wrong answer for a slow one, while a second
          // attempt addresses a cold connection directly. Ceilings 5s then 8s.
          const { data: s, error: qErr } = await retryWithTimeout(
            () => supabase.from('studio_accounts')
              .select('studio_name, photo_source, ai_photo_prompt, brand_color, brand_color_secondary, brand_font, brand_voice, logo_url, logo_light_url, logo_dark_url, watermark_default_zone, watermark_default_variant, is_beta, studio_type, last_content_types')
              .eq('id', ri.studioId).single(),
            {
              ceilings: [5000, 8000],
              label: 'studio_accounts',
              onRetry: (err, attempt, attemptMs) => {
                studioAttempts = attempt + 1
                updates.studioLoadRetried = true
                console.warn(`[FCA] studio_accounts attempt ${attempt} gave up after ${attemptMs}ms (ceiling 5000ms) — retrying with an 8000ms ceiling. No server response yet; the first query may still be running.`)
              },
            }
          )
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

  const runRestore = useCallback(async () => {
    setAuthUnresolved(false)
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
        await initWithUser(session)
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
  }, [app, initWithUser])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    let mounted = true
    runRestore()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
        await initWithUser(session)
        setAuthUnresolved(false)
        if (valveRef.current) clearTimeout(valveRef.current)
      } else if (event === 'SIGNED_OUT') {
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

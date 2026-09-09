import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import { nextPathFromQuery } from '../lib/deepLink'
import CheckYourEmail from '../components/CheckYourEmail'

/**
 * HOW THE PAGE WAS OPENED, CAPTURED BEFORE ANYTHING CAN ERASE IT.
 *
 * The client is created with supabase-js defaults, which means detectSessionInUrl: true. On
 * startup it parses the magic-link fragment and then strips it from the address bar with
 * history.replaceState. By the time a component effect runs, `window.location.hash` may already
 * be empty -- so reading it inside the effect is a race, and losing that race would classify a
 * genuine magic-link arrival as a plain visit.
 *
 * Module evaluation is synchronous and completes before any promise callback runs, so this
 * constant is written while the original URL is still intact. It is the only trustworthy record
 * of how this page load began.
 */
const ARRIVAL_HASH = typeof window !== 'undefined' ? window.location.hash : ''
const ARRIVAL_SEARCH = typeof window !== 'undefined' ? window.location.search : ''

/**
 * Did this page load carry an auth callback from GoTrue?
 *
 * This is the distinction the old code could not make. getSession() answers "is there a session",
 * which is true both for someone who just clicked their link AND for someone who signed in weeks
 * ago on this browser. Only the URL says which happened.
 *
 * An error fragment counts as an arrival. `#error=access_denied&error_code=otp_expired` means the
 * studio DID click a link and it failed; they should get the existing expired-link handling, not
 * a "check your email" page telling them to go and click it again.
 */
export function isAuthCallbackArrival(hash, search) {
  const h = typeof hash === 'string' ? hash : ''
  const s = typeof search === 'string' ? search : ''
  if (/[#&]access_token=/.test(h)) return true          // implicit flow -- this project's default
  if (/[#&]error(_code|_description)?=/.test(h)) return true  // GoTrue failure reply
  if (/[?&]code=/.test(s)) return true                  // PKCE, if flowType is ever switched
  return false
}

const IS_ARRIVAL = isAuthCallbackArrival(ARRIVAL_HASH, ARRIVAL_SEARCH)

export default function AuthCallback() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, authReady } = useApp()

  useEffect(() => {
    // ONLY the magic-link path does async work. See the render note below for why the other
    // path must not.
    if (!IS_ARRIVAL) return

    const handle = async () => {
      // A real magic-link round trip. UNCHANGED from the original implementation.
      const { data: { session }, error } = await supabase.auth.getSession()
      if (error || !session) {
        navigate('/login?error=magic_link_expired', { replace: true })
        return
      }
      // THE security-critical read. GoTrue hands back whatever redirect_to it was
      // given, and POST /auth/v1/otp is reachable with the public anon key -- so a
      // crafted link can arrive here carrying any ?next= at all, on a session that
      // authenticated for real. nextPathFromQuery allowlists it; nothing else does.
      navigate(nextPathFromQuery(location.search), { replace: true })
    }
    handle()
  }, [navigate, location.search])

  const handleSignOut = async () => {
    // Deliberately does not navigate: the studio still needs to read this page and open their
    // inbox. AuthProvider's onAuthStateChange handles SIGNED_OUT and resets the app context.
    try {
      await supabase.auth.signOut()
    } catch {
      // A failed sign-out must not blank the page they are trying to read.
    }
  }

  if (!IS_ARRIVAL) {
    // No auth callback in the URL: the Stripe success_url landing, or a stray visit.
    //
    // RENDERED SYNCHRONOUSLY, WITH NO AUTH CALL OF ITS OWN. The first version of this awaited
    // supabase.auth.getSession() here just to learn who was signed in, and that was a real bug,
    // caught on production: supabase-js guards the auth token with a navigator lock, AuthProvider
    // is calling getSession() at the same moment on mount, and the two contend --
    //   "[FCA] restoreSession error: TIMEOUT: getSession (5000ms)"
    //   "Lock sb-<ref>-auth-token was released because another request stole it"
    // -- so the await rejected, the effect threw, the phase state never advanced and the page sat
    // on "Logging you in..." forever. On the exact URL shape Stripe is about to start sending.
    //
    // The fix is not a try/catch, it is not making the call. Requirement 2 is "never inherit a
    // session", which needs no knowledge of the session at all: render the page, unconditionally
    // and immediately. Whose session it is only decorates the notice below, and that comes from
    // AppContext, which AuthProvider populates once -- no second auth call, nothing to contend
    // with, and nothing that can hang.
    //
    // The banner is therefore best-effort by design: if AuthProvider is slow or its own read
    // times out, `user` stays null and the notice is simply absent. The page is still correct.
    const signedInAs = authReady ? (user?.email ?? null) : null
    return (
      <CheckYourEmail
        signedInAs={signedInAs}
        onSignOut={signedInAs ? handleSignOut : null}
      />
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#0A0B0D' }}>
      <div className="flex flex-col items-center gap-3">
        <Loader2 size={28} className="animate-spin" style={{ color: 'var(--brand-primary)' }} />
        <p className="text-slate-300 text-sm">Logging you in…</p>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
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

export default function AuthCallback() {
  const navigate = useNavigate()
  const location = useLocation()
  const [signedInAs, setSignedInAs] = useState(null)
  const [phase, setPhase] = useState('working')   // 'working' | 'check-email'

  useEffect(() => {
    const handle = async () => {
      if (isAuthCallbackArrival(ARRIVAL_HASH, ARRIVAL_SEARCH)) {
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
        return
      }

      // No auth callback in the URL. This is the Stripe success_url landing (or a stray visit).
      //
      // DO NOT navigate on the strength of an existing session. Whatever is in localStorage
      // belongs to whoever last signed in on this browser, which is not necessarily the person
      // who just paid -- and redirecting into it is precisely the 2026-09-08 defect. The studio
      // that just checked out is authenticated by the link in their inbox, and by nothing else.
      const { data: { session } } = await supabase.auth.getSession()
      setSignedInAs(session?.user?.email ?? null)
      setPhase('check-email')
    }
    handle()
  }, [navigate, location.search])

  const handleSignOut = async () => {
    // Deliberately does not navigate: the studio still needs to read this page and open their
    // inbox. AuthProvider's onAuthStateChange handles SIGNED_OUT and resets the app context.
    await supabase.auth.signOut()
    setSignedInAs(null)
  }

  if (phase === 'check-email') {
    // No address is passed. Resolving Stripe's ?session_id= to the checkout email needs a
    // server-side secret-key lookup, which was scoped out; see CheckYourEmail for the detail.
    return <CheckYourEmail signedInAs={signedInAs} onSignOut={signedInAs ? handleSignOut : null} />
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

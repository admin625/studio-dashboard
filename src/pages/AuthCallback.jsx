import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { nextPathFromQuery } from '../lib/deepLink'

export default function AuthCallback() {
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    const handle = async () => {
      // Supabase JS automatically processes the magic-link hash on page load
      // and fires onAuthStateChange. We just need to wait for the session
      // and redirect.
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

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#0A0B0D' }}>
      <div className="flex flex-col items-center gap-3">
        <Loader2 size={28} className="animate-spin" style={{ color: 'var(--brand-primary)' }} />
        <p className="text-slate-300 text-sm">Logging you in…</p>
      </div>
    </div>
  )
}

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

export default function AuthCallback() {
  const navigate = useNavigate()

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
      navigate('/deliveries', { replace: true })
    }
    handle()
  }, [navigate])

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#0A0B0D' }}>
      <div className="flex flex-col items-center gap-3">
        <Loader2 size={28} className="animate-spin" style={{ color: 'var(--brand-primary)' }} />
        <p className="text-slate-300 text-sm">Logging you in…</p>
      </div>
    </div>
  )
}

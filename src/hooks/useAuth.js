import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import { buildCallbackUrl } from '../lib/deepLink'

/**
 * useAuth — provides login(), loginWithMagicLink(), and signOut() actions.
 * Session restore and auth state listening is handled by AuthProvider.
 */
export function useAuth() {
  const app = useApp()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)

  const login = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    // AuthProvider's onAuthStateChange will handle initWithUser
    return data
  }, [])

  // `destination` is where the studio was headed before being bounced to login.
  // It rides on the callback URL because GoTrue carries redirect_to through the
  // whole round trip -- the only carrier that survives a mail client opening the
  // link in a new tab. Allowlist-validated inside buildCallbackUrl, and again on
  // read in AuthCallback, which is the check that actually matters: this endpoint
  // is reachable with the public anon key, so an attacker can mint a link with any
  // redirect_to without ever touching this code.
  const loginWithMagicLink = useCallback(async (email, destination) => {
    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: buildCallbackUrl(window.location.origin, destination),
          shouldCreateUser: false,
        },
      })
      if (error) throw error
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    } finally {
      setLoading(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    app.reset()
    app.update({ authReady: true })
    navigate('/login')
  }, [app, navigate])

  return { login, loginWithMagicLink, signOut, isAuthenticated: !!app.user, loading }
}

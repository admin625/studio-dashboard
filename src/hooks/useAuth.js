import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'

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

  const loginWithMagicLink = useCallback(async (email) => {
    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
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

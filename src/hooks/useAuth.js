import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'

/**
 * useAuth — provides login() and signOut() actions.
 * Session restore and auth state listening is handled by AuthProvider.
 */
export function useAuth() {
  const app = useApp()
  const navigate = useNavigate()

  const login = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    // AuthProvider's onAuthStateChange will handle initWithUser
    return data
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    app.reset()
    app.update({ authReady: true })
    navigate('/login')
  }, [app, navigate])

  return { login, signOut, isAuthenticated: !!app.user }
}

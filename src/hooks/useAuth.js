import { useEffect, useCallback, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'

/**
 * Port of Auth._lookupUserRole + _initWithUser from legacy SPA.
 * Handles: session restore, login, logout, role detection, studio data loading.
 */
export function useAuth() {
  const app = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const initRunning = useRef(false)

  const lookupUserRole = useCallback(async (email, attempt = 1) => {
    try {
      // Check studio_instructors first
      const { data: instr, error: instrErr } = await supabase
        .from('studio_instructors')
        .select('id, studio_id')
        .eq('instructor_email', email)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle()

      if (instrErr) console.error('[Auth] studio_instructors error:', instrErr)
      if (instr) {
        return { role: 'studio_instructor', studioId: instr.studio_id, clientId: null, scopeType: 'studio' }
      }

      // Check clients table
      const { data: client, error: clientErr } = await supabase
        .from('clients')
        .select('id, email, studio_id, is_studio_instructor')
        .eq('email', email)
        .maybeSingle()

      if (clientErr) console.error('[Auth] clients error:', clientErr)
      if (client) {
        if (client.studio_id) {
          return { role: 'studio_owner', studioId: client.studio_id, clientId: client.id, scopeType: 'studio' }
        }
        return { role: 'individual', studioId: null, clientId: client.id, scopeType: 'individual' }
      }

      return null
    } catch (err) {
      console.error('[Auth] lookupUserRole error (attempt', attempt, '):', err.message)
      if (attempt < 2) return lookupUserRole(email, attempt + 1)
      return null
    }
  }, [])

  const initWithUser = useCallback(async (user) => {
    if (initRunning.current) return
    if (app.email === user.email && app.role) return
    initRunning.current = true

    try {
      const ri = await lookupUserRole(user.email)
      if (!ri) {
        app.update({ user, email: user.email, role: null, authReady: true })
        initRunning.current = false
        return
      }

      const updates = {
        user,
        email: user.email,
        role: ri.role,
        scopeType: ri.scopeType,
        resolvedStudioId: ri.studioId,
        resolvedClientId: ri.clientId,
        authReady: true,
      }

      // Load studio settings if we have a studioId
      if (ri.studioId) {
        try {
          const { data: s } = await supabase
            .from('studio_accounts')
            .select('studio_name, photo_source, ai_photo_prompt, brand_color, brand_color_secondary, brand_font, brand_voice, logo_url, is_beta, studio_type, last_content_types')
            .eq('id', ri.studioId)
            .single()

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
              isBeta: s.is_beta || false,
              studioType: s.studio_type || '',
              lastContentTypes: s.last_content_types || [],
            })
          }
        } catch (e) {
          console.warn('[Auth] Failed to load studio settings:', e.message)
        }
      }

      app.update(updates)
      console.log('[Auth] SUCCESS — role:', ri.role, '| studioId:', ri.studioId)

      // Navigate to dashboard if we're on login
      if (location.pathname === '/login' || location.pathname === '/') {
        navigate('/deliveries')
      }
    } catch (err) {
      console.error('[Auth] initWithUser error:', err)
      app.update({ authReady: true })
    } finally {
      initRunning.current = false
    }
  }, [app, lookupUserRole, navigate, location.pathname])

  // Login handler
  const login = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    if (data?.user) await initWithUser(data.user)
    return data
  }, [initWithUser])

  // Sign out
  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    app.reset()
    navigate('/login')
  }, [app, navigate])

  // Session restore + auth state listener
  useEffect(() => {
    let mounted = true

    const restoreSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!mounted) return

      if (session?.user) {
        await initWithUser(session.user)
      } else {
        app.update({ authReady: true })
        if (location.pathname !== '/forgot-password' && location.pathname !== '/reset-password') {
          navigate('/login')
        }
      }
    }

    restoreSession()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return

      if (event === 'PASSWORD_RECOVERY') {
        navigate('/reset-password')
        return
      }
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
        if (location.pathname !== '/reset-password') {
          await initWithUser(session.user)
        }
      } else if (event === 'SIGNED_OUT') {
        app.reset()
        app.update({ authReady: true })
        navigate('/login')
      }
    })

    return () => {
      mounted = false
      subscription?.unsubscribe()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { login, signOut, isAuthenticated: !!app.user }
}

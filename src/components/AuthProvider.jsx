/**
 * AuthProvider — runs session restore on mount, sets authReady.
 * Must wrap all routes so auth state is available everywhere.
 */
import { useEffect, useRef, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'

export default function AuthProvider({ children }) {
  const app = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const initRunning = useRef(false)
  const initialized = useRef(false)

  const lookupUserRole = useCallback(async (email, attempt = 1) => {
    try {
      const { data: instr } = await supabase
        .from('studio_instructors')
        .select('id, studio_id')
        .eq('instructor_email', email)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle()
      if (instr) return { role: 'studio_instructor', studioId: instr.studio_id, clientId: null, scopeType: 'studio' }

      const { data: client } = await supabase
        .from('clients')
        .select('id, email, studio_id, is_studio_instructor')
        .eq('email', email)
        .maybeSingle()
      if (client?.studio_id) return { role: 'studio_owner', studioId: client.studio_id, clientId: client.id, scopeType: 'studio' }
      if (client) return { role: 'individual', studioId: null, clientId: client.id, scopeType: 'individual' }
      return null
    } catch (err) {
      if (attempt < 2) return lookupUserRole(email, attempt + 1)
      return null
    }
  }, [])

  const initWithUser = useCallback(async (user) => {
    if (initRunning.current) return
    initRunning.current = true
    try {
      const ri = await lookupUserRole(user.email)
      const updates = {
        user, email: user.email,
        role: ri?.role || null,
        scopeType: ri?.scopeType || null,
        resolvedStudioId: ri?.studioId || null,
        resolvedClientId: ri?.clientId || null,
        authReady: true,
      }
      if (ri?.studioId) {
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
        } catch (e) { /* ignore */ }
      }
      app.update(updates)
    } catch (err) {
      console.error('[Auth] initWithUser error:', err)
      app.update({ authReady: true })
    } finally {
      initRunning.current = false
    }
  }, [app, lookupUserRole])

  useEffect(() => {
    console.log('[FCA] AuthProvider mounted, initialized:', initialized.current)
    if (initialized.current) return
    initialized.current = true

    let mounted = true

    const restoreSession = async () => {
      console.log('[FCA] restoreSession starting...')
      try {
        const { data: { session }, error } = await supabase.auth.getSession()
        console.log('[FCA] getSession result:', { hasSession: !!session, hasUser: !!session?.user, error: error?.message || null })
        if (!mounted) return
        if (session?.user) {
          console.log('[FCA] Session found for:', session.user.email, '— calling initWithUser')
          await initWithUser(session.user)
          console.log('[FCA] initWithUser complete, authReady should be true')
        } else {
          console.log('[FCA] No session, setting authReady = true')
          app.update({ authReady: true })
        }
      } catch (err) {
        console.error('[FCA] getSession error:', err)
        if (mounted) app.update({ authReady: true })
      }
    }

    restoreSession()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[FCA] onAuthStateChange:', event, { hasUser: !!session?.user })
      if (!mounted) return
      if (event === 'SIGNED_IN' && session?.user) {
        await initWithUser(session.user)
      } else if (event === 'SIGNED_OUT') {
        app.reset()
        app.update({ authReady: true })
      }
    })

    return () => { mounted = false; subscription?.unsubscribe() }
  }, []) // eslint-disable-line

  return children
}

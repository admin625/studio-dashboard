/**
 * AuthProvider — runs session restore on mount, sets authReady.
 * Must wrap all routes so auth state is available everywhere.
 * All Supabase queries have 5s timeouts to prevent infinite hangs.
 */
import { useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT: ${label} (${ms}ms)`)), ms))
  ])
}

// Hardcoded admin accounts — bypass all Supabase role AND studio lookups
const ADMIN_ACCOUNTS = {
  'admin@fiorsaoirse.com': {
    role: 'studio_owner',
    studioId: '085fde09-d7f7-486f-89d6-d65fc1838ab0',
    clientId: 'f896e176-ee81-4a7f-9414-500caba002fd',
    scopeType: 'studio',
    studioData: {
      studio_name: 'Mac Test Studio v2',
      photo_source: 'ai_assist',
      ai_photo_prompt: '',
      brand_color: '#667eea',
      brand_color_secondary: '',
      brand_font: '',
      brand_voice: '',
      logo_url: '',
      is_beta: true,
      studio_type: '',
      last_content_types: [],
    },
  },
}

export default function AuthProvider({ children }) {
  const app = useApp()
  const initialized = useRef(false)

  const lookupUserRole = useCallback(async (email) => {
    // Admin bypass — no queries, no timeouts, instant access
    if (ADMIN_ACCOUNTS[email]) {
      console.log('[FCA] ADMIN BYPASS for:', email)
      return ADMIN_ACCOUNTS[email]
    }

    console.log('[FCA] lookupUserRole for:', email)
    try {
      console.log('[FCA] querying studio_instructors...')
      const { data: instr, error: e1 } = await withTimeout(
        supabase.from('studio_instructors').select('id, studio_id').eq('instructor_email', email).eq('status', 'active').limit(1).maybeSingle(),
        5000, 'studio_instructors'
      )
      console.log('[FCA] studio_instructors result:', { found: !!instr, error: e1?.message })
      if (instr) return { role: 'studio_instructor', studioId: instr.studio_id, clientId: null, scopeType: 'studio' }

      console.log('[FCA] querying clients...')
      const { data: client, error: e2 } = await withTimeout(
        supabase.from('clients').select('id, email, studio_id, is_studio_instructor').eq('email', email).maybeSingle(),
        5000, 'clients'
      )
      console.log('[FCA] clients result:', { found: !!client, studioId: client?.studio_id, error: e2?.message })
      if (client?.studio_id) return { role: 'studio_owner', studioId: client.studio_id, clientId: client.id, scopeType: 'studio' }
      if (client) return { role: 'individual', studioId: null, clientId: client.id, scopeType: 'individual' }
      return null
    } catch (err) {
      console.error('[FCA] lookupUserRole error:', err.message)
      return null
    }
  }, [])

  const initWithUser = useCallback(async (user) => {
    console.log('[FCA] initWithUser for:', user.email)
    try {
      const ri = await lookupUserRole(user.email)
      console.log('[FCA] role result:', ri)

      const updates = {
        user, email: user.email,
        role: ri?.role || null,
        scopeType: ri?.scopeType || null,
        resolvedStudioId: ri?.studioId || null,
        resolvedClientId: ri?.clientId || null,
        authReady: true,
      }

      // Admin accounts have studioData baked in — skip the Supabase query entirely
      const adminData = ADMIN_ACCOUNTS[user.email]
      if (adminData?.studioData) {
        console.log('[FCA] ADMIN BYPASS: using hardcoded studio data')
        const s = adminData.studioData
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
      } else if (ri?.studioId) {
        console.log('[FCA] loading studio_accounts for:', ri.studioId)
        try {
          const { data: s, error: e3 } = await withTimeout(
            supabase.from('studio_accounts')
              .select('studio_name, photo_source, ai_photo_prompt, brand_color, brand_color_secondary, brand_font, brand_voice, logo_url, is_beta, studio_type, last_content_types')
              .eq('id', ri.studioId).single(),
            5000, 'studio_accounts'
          )
          console.log('[FCA] studio_accounts result:', { found: !!s, name: s?.studio_name, error: e3?.message })
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
          console.warn('[FCA] studio_accounts load failed:', e.message)
        }
      }

      console.log('[FCA] calling app.update with authReady: true')
      app.update(updates)
      console.log('[FCA] app.update DONE — auth flow complete')
    } catch (err) {
      console.error('[FCA] initWithUser fatal error:', err)
      app.update({ authReady: true })
    }
  }, [app, lookupUserRole])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    let mounted = true

    // Safety valve: if nothing sets authReady within 10s, force it
    const safetyTimer = setTimeout(() => {
      console.warn('[FCA] SAFETY VALVE: authReady forced after 10s timeout')
      app.update({ authReady: true })
    }, 10000)

    const restoreSession = async () => {
      console.log('[FCA] restoreSession starting...')
      try {
        const { data: { session }, error } = await withTimeout(
          supabase.auth.getSession(),
          5000, 'getSession'
        )
        console.log('[FCA] getSession:', { hasSession: !!session, hasUser: !!session?.user, error: error?.message })
        if (!mounted) return

        if (session?.user) {
          await initWithUser(session.user)
        } else {
          console.log('[FCA] No session — setting authReady = true')
          app.update({ authReady: true })
        }
      } catch (err) {
        console.error('[FCA] restoreSession error:', err.message)
        if (mounted) app.update({ authReady: true })
      }
      clearTimeout(safetyTimer)
    }

    restoreSession()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[FCA] onAuthStateChange:', event)
      if (!mounted) return
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
        await initWithUser(session.user)
        clearTimeout(safetyTimer)
      } else if (event === 'SIGNED_OUT') {
        app.reset()
        app.update({ authReady: true })
        clearTimeout(safetyTimer)
      }
    })

    return () => {
      mounted = false
      clearTimeout(safetyTimer)
      subscription?.unsubscribe()
    }
  }, []) // eslint-disable-line

  return children
}

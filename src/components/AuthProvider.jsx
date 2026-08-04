/**
 * AuthProvider — runs session restore on mount, sets authReady.
 * Must wrap all routes so auth state is available everywhere.
 * All Supabase queries have 5s timeouts to prevent infinite hangs.
 */
import { useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { withTimeout } from '../lib/withTimeout'
import { useApp } from '../context/AppContext'

// Default brand colors — match :root in index.css
const DEFAULT_BRAND_PRIMARY = '#667eea'
const DEFAULT_BRAND_SECONDARY = '#764ba2'

/**
 * Write the studio's brand colors to CSS custom properties on <html>.
 * Every component (React or raw CSS) can then read them via
 * var(--brand-primary) / var(--brand-secondary). Passing null/empty
 * resets to the default purple.
 */
function applyBrandColors(primary, secondary) {
  const root = document.documentElement
  root.style.setProperty('--brand-primary', primary || DEFAULT_BRAND_PRIMARY)
  root.style.setProperty('--brand-secondary', secondary || DEFAULT_BRAND_SECONDARY)
}

/**
 * Normalize the JWT app_metadata role into the app's internal vocabulary.
 * The access token carries 'studio_owner' or 'instructor'; the app gates on
 * 'studio_owner' / 'studio_instructor'. Anything else (individual/unknown/absent)
 * returns null so resolution falls through to the table lookup.
 */
function normalizeRole(r) {
  if (r === 'studio_owner') return 'studio_owner'
  if (r === 'instructor' || r === 'studio_instructor') return 'studio_instructor'
  return null
}

/**
 * Read a single claim from a JWT without verifying it (client-side read only).
 * The server-side custom_access_token_hook injects `fca_studio_id` for studio
 * sessions; mirrors the decoder already used in ReelUpload.
 */
function decodeJwtClaim(token, key) {
  try {
    const part = token.split('.')[1]
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)[key] ?? null
  } catch {
    return null
  }
}

// Hardcoded admin accounts — bypass the ROLE/SCOPE lookup only.
//
// ⚠️ DO NOT reintroduce a `studioData` key here. It used to bake brand fields in and skip the
// studio_accounts query entirely, which meant the admin session rendered a correct-looking role
// and studio name from literals while brand_font, brand_voice, brand_color_secondary,
// studio_type, is_beta and all three logo URLs showed blank — every one of them populated in the
// database the whole time.
//
// That was a data-loss path, not a display bug. BrandSettings seeds its form state from this
// context and saves what it displays, and its own guard (authReady + studioLoadError) is
// satisfied by construction when the values are baked — so the guard that exists precisely to
// stop defaults overwriting stored values could not see the blanks coming through it.
//
// The bypass exists to skip the slow, timeout-prone role lookup. studioId is known right here,
// so the normal studio_accounts query works fine and admin now reads real brand data like every
// other account.
const ADMIN_ACCOUNTS = {
  'admin@fiorsaoirse.com': {
    role: 'studio_owner',
    studioId: '085fde09-d7f7-486f-89d6-d65fc1838ab0',
    clientId: 'f896e176-ee81-4a7f-9414-500caba002fd',
    scopeType: 'studio',
  },
}

export default function AuthProvider({ children }) {
  const app = useApp()
  const initialized = useRef(false)

  const lookupUserRole = useCallback(async (email) => {
    // Admin bypass — no queries, no timeouts, instant access
    if (ADMIN_ACCOUNTS[email]) {
      return ADMIN_ACCOUNTS[email]
    }

    try {
      const { data: instr } = await withTimeout(
        supabase.from('studio_instructors').select('id, studio_id').eq('instructor_email', email).eq('status', 'active').limit(1).maybeSingle(),
        5000, 'studio_instructors'
      )
      if (instr) return { role: 'studio_instructor', studioId: instr.studio_id, clientId: null, scopeType: 'studio' }

      const { data: client } = await withTimeout(
        supabase.from('clients').select('id, email, studio_id, is_studio_instructor').eq('email', email).maybeSingle(),
        5000, 'clients'
      )
      if (client?.studio_id) return { role: 'studio_owner', studioId: client.studio_id, clientId: client.id, scopeType: 'studio' }
      if (client) return { role: 'individual', studioId: null, clientId: client.id, scopeType: 'individual' }
      return null
    } catch (err) {
      console.error('[FCA] lookupUserRole error:', err.message)
      return null
    }
  }, [])

  const initWithUser = useCallback(async (session) => {
    const user = session.user
    try {
      // 2a — Resolve role + studio scope from the JWT rather than the
      // timeout-prone studio_instructors/clients lookup. The access token
      // carries app_metadata.role and (via custom_access_token_hook) the
      // fca_studio_id claim, so studio sessions resolve synchronously and can
      // never be left with a null role/scope by a slow or timed-out query —
      // the root cause of the owner-only-UI and delivery-access races.
      // Admins keep their existing bypass; individual-scope and legacy sessions
      // (no fca_studio_id claim) fall back to the table lookup, which also
      // supplies the resolvedClientId used by the individual client_id leg.
      const isAdmin = !!ADMIN_ACCOUNTS[user.email]
      const jwtRole = normalizeRole(user.app_metadata?.role)
      const claimStudioId = decodeJwtClaim(session.access_token, 'fca_studio_id')

      let ri
      if (!isAdmin && jwtRole && claimStudioId) {
        ri = { role: jwtRole, studioId: claimStudioId, clientId: null, scopeType: 'studio' }
      } else {
        ri = await lookupUserRole(user.email)
        // Prefer the JWT role even on the fallback path (studioId still from lookup).
        if (!isAdmin && jwtRole && ri) ri = { ...ri, role: jwtRole }
      }

      const updates = {
        user, email: user.email,
        role: ri?.role || null,
        scopeType: ri?.scopeType || null,
        resolvedStudioId: ri?.studioId || null,
        resolvedClientId: ri?.clientId || null,
        authReady: true,
        studioLoadError: false,
      }

      // Every studio session — admin included — loads its brand from studio_accounts. There is
      // no baked-data branch: see the note on ADMIN_ACCOUNTS above for why it was removed.
      if (ri?.studioId) {
        try {
          const { data: s, error: qErr } = await withTimeout(
            supabase.from('studio_accounts')
              .select('studio_name, photo_source, ai_photo_prompt, brand_color, brand_color_secondary, brand_font, brand_voice, logo_url, logo_light_url, logo_dark_url, watermark_default_zone, watermark_default_variant, is_beta, studio_type, last_content_types')
              .eq('id', ri.studioId).single(),
            5000, 'studio_accounts'
          )
          if (qErr) throw qErr
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
              brandLogoLightUrl: s.logo_light_url || '',
              brandLogoDarkUrl: s.logo_dark_url || '',
              watermarkDefaultZone: s.watermark_default_zone || 'bottom-right',
              watermarkDefaultVariant: s.watermark_default_variant || 'auto',
              isBeta: s.is_beta || false,
              studioType: s.studio_type || '',
              lastContentTypes: s.last_content_types || [],
            })
            applyBrandColors(s.brand_color, s.brand_color_secondary)
          } else {
            // Query succeeded but returned no row — RLS likely blocked or wrong id
            updates.studioLoadError = true
          }
        } catch (e) {
          console.warn('[FCA] studio_accounts load failed:', e.message)
          updates.studioLoadError = true
        }
      }

      app.update(updates)
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
      try {
        const { data: { session } } = await withTimeout(
          supabase.auth.getSession(),
          5000, 'getSession'
        )
        if (!mounted) return

        if (session?.user) {
          await initWithUser(session)
        } else {
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
      if (!mounted) return
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
        await initWithUser(session)
        clearTimeout(safetyTimer)
      } else if (event === 'SIGNED_OUT') {
        app.reset()
        app.update({ authReady: true })
        applyBrandColors(null, null)
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

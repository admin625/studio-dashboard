import { createContext, useContext, useState, useCallback } from 'react'

const AppContext = createContext(null)

const INITIAL_STATE = {
  user: null,
  email: '',
  role: null,
  // True only for an ADMIN_ACCOUNTS email (AuthProvider). Gates INTERNAL DEBUG UI —
  // the reel-upload RLS self-test and its raw id block — so a studio never sees
  // developer furniture on a page she can reach.
  //
  // ⚠️ NOT a permission, and must never become one. It is set from a client-side
  // email comparison, so it is trivially forgeable by anyone editing their own app
  // state; every real capability is enforced by `_authz.cjs requireStudioAccess` and
  // RLS. Use it to decide what to RENDER, never what to allow. Defaults false, so a
  // session that fails to resolve shows the studio-safe view rather than the debug one.
  isAdmin: false,
  scopeType: null,
  resolvedStudioId: null,
  resolvedClientId: null,
  authReady: false,
  studioLoadError: false,
  // studioLoaded is the PROPERTY (this session's brand data is in state).
  // authReady is only a proxy for it, and a broken one: the 10s safety valve
  // sets authReady on its own, with no brand fields attached. Anything that can
  // WRITE brand data must gate on studioLoaded, never on authReady.
  studioLoaded: false,
  // True when the studio_accounts read needed its second attempt. Surfaced so
  // the retry is observable in app state, not only in console output.
  studioLoadRetried: false,
  // Wall-clock ms for a SUCCESSFUL studio_accounts read. This is the number that
  // makes the 5000ms ceiling arguable from data rather than from instinct.
  studioLoadMs: null,
  // { kind, attempts, elapsedMs, code } on failure — see lib/studioLoadDiagnostics.
  // Kind matters: a client timeout, an RLS-denied zero-row read, and a real
  // database error demand three different responses and used to be one string.
  studioLoadFailure: null,
  // Studio settings
  photoSource: 'studio_only',
  aiPhotoPrompt: '',
  brandColorPrimary: '',
  brandColorSecondary: '',
  brandFont: '',
  brandVoice: '',
  brandLogoUrl: '',
  brandLogoLightUrl: '',
  brandLogoDarkUrl: '',
  watermarkDefaultZone: 'bottom-right',
  watermarkDefaultVariant: 'auto',
  studioType: '',
  studioName: '',
  isBeta: false,
  lastContentTypes: [],
  // Photos
  studioPhotos: [],
  filteredPhotos: [],
}

export function AppProvider({ children }) {
  const [state, setState] = useState(INITIAL_STATE)

  const update = useCallback((updates) => {
    setState(prev => ({ ...prev, ...updates }))
  }, [])

  const reset = useCallback(() => {
    setState(INITIAL_STATE)
  }, [])

  return (
    <AppContext.Provider value={{ ...state, update, reset }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}

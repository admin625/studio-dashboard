import { createContext, useContext, useState, useCallback } from 'react'

const AppContext = createContext(null)

const INITIAL_STATE = {
  user: null,
  email: '',
  role: null,
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

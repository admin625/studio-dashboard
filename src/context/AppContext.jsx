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

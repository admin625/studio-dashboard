import { Navigate, useLocation } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { Loader2 } from 'lucide-react'
import { withNext, voiceGateRedirect } from '../lib/deepLink'

export default function ProtectedRoute({ children }) {
  const { authReady, user, role, studioLoaded, brandVoice } = useApp()
  const location = useLocation()

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#0A0B0D' }}>
        <div className="text-center">
          <Loader2 size={32} className="animate-spin text-indigo-400 mx-auto mb-4" />
          <p className="text-slate-400 text-sm">Loading your studio...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    // Carry the intended destination in the URL. Previously it was lost entirely,
    // so an email deep link died at the login boundary; then it was stashed in
    // sessionStorage, which could not survive a magic link opening in a new tab.
    // The URL is the only carrier that survives every hop, including out to a mail
    // client and back. Validated on read at each consumer — see lib/deepLink.js.
    return <Navigate to={withNext('/login', location.pathname)} replace />
  }

  // AG-1.1a: an owner with no stored brand voice sets it up before anything else. The decision
  // (owner, hydrated, empty, not already on an open route) lives in lib/deepLink — one place.
  const gate = voiceGateRedirect({ role, studioLoaded, brandVoice, pathname: location.pathname })
  if (gate) return <Navigate to={gate} replace />

  return children
}

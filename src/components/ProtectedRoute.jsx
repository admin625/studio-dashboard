import { Navigate, useLocation } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { Loader2 } from 'lucide-react'
import { stashPendingPath } from '../lib/deepLink'

export default function ProtectedRoute({ children }) {
  const { authReady, user } = useApp()
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
    // Remember where they were headed so login can return them there. Previously
    // this destination was simply lost, so an email deep link died at the login
    // boundary even once /?id= was honoured — the deep link would work only for
    // sessions that happened to already be signed in.
    //
    // Written BOTH ways deliberately. `state` covers the in-app hop to /login;
    // sessionStorage additionally survives a magic link, which leaves the app and
    // returns to /auth/callback as a fresh document where history state is gone.
    // Both are allowlist-validated on the way out, never trusted on the way in.
    stashPendingPath(location.pathname)
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return children
}

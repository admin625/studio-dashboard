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
    //
    // ACCEPTED TRADE-OFF: this is a side effect during render, not in an effect.
    // Flagged in review 2026-08-17 and deliberately not restructured. It is
    // idempotent — the same path written twice — so StrictMode's double-invoke is
    // harmless; the residual risk is that a speculative render which never commits
    // still writes, which this app's routes cannot currently produce (no Suspense
    // or transitions here). Moving it into an effect would change ordering on the
    // auth path, and this repo's auth surface is where the hydration-gate and
    // admin-bypass problems came from. Not worth that blast radius for a write with
    // no visible failure mode. Revisit if these routes ever gain Suspense.
    stashPendingPath(location.pathname)
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return children
}

import { Navigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { Loader2 } from 'lucide-react'

export default function ProtectedRoute({ children }) {
  const { authReady, user } = useApp()

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
    return <Navigate to="/login" replace />
  }

  return children
}

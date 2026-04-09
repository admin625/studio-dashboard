import { useApp } from '../context/AppContext'
import { useAuth } from '../hooks/useAuth'
import { LogOut } from 'lucide-react'

export default function Layout({ children }) {
  const { email, role, studioName } = useApp()
  const { signOut } = useAuth()

  const roleBadge = {
    studio_owner: { label: 'Studio Owner', bg: '#059669', color: '#fff' },
    studio_instructor: { label: 'Instructor', bg: '#8b5cf6', color: '#fff' },
    individual: { label: 'Member', bg: '#3b82f6', color: '#fff' },
  }

  const badge = roleBadge[role] || { label: role || 'Unknown', bg: '#64748b', color: '#fff' }

  return (
    <div className="min-h-screen" style={{ background: '#0A0B0D' }}>
      {/* Top bar */}
      <div
        className="sticky top-0 z-50 backdrop-blur-md px-6 py-3 flex items-center justify-between"
        style={{ background: 'rgba(10,11,13,0.85)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-center gap-4">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #667eea, #764ba2)' }}
          >
            <span className="text-white text-xs font-bold font-display">F</span>
          </div>
          <div>
            <p className="text-xs text-white font-medium">{studioName || email}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span
                className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                style={{ background: badge.bg, color: badge.color }}
              >
                {badge.label}
              </span>
              {email && studioName && (
                <span className="text-[10px] text-slate-600">{email}</span>
              )}
            </div>
          </div>
        </div>

        <button
          onClick={signOut}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-slate-400
                     hover:text-white hover:bg-white/5 transition-all"
        >
          <LogOut size={14} />
          Sign Out
        </button>
      </div>

      {/* Page content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        {children}
      </div>
    </div>
  )
}

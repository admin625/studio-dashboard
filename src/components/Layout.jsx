import { useApp } from '../context/AppContext'
import { useAuth } from '../hooks/useAuth'
import { useLocation, Link } from 'react-router-dom'
import { LogOut, Palette, LayoutGrid } from 'lucide-react'

export default function Layout({ children }) {
  const { email, role, studioName, brandColorPrimary } = useApp()
  const { signOut } = useAuth()
  const location = useLocation()

  const primary = brandColorPrimary || '#667eea'
  const isOwner = role === 'studio_owner'

  const roleBadge = {
    studio_owner: { label: 'Studio Owner', bg: '#059669', color: '#fff' },
    studio_instructor: { label: 'Instructor', bg: '#8b5cf6', color: '#fff' },
    individual: { label: 'Member', bg: '#3b82f6', color: '#fff' },
  }
  const badge = roleBadge[role] || { label: role || 'Unknown', bg: '#64748b', color: '#fff' }

  const navItems = [
    { path: '/deliveries', label: 'Content', Icon: LayoutGrid, show: true },
    { path: '/brand', label: 'Brand', Icon: Palette, show: isOwner },
  ].filter(n => n.show)

  return (
    <div className="min-h-screen" style={{ background: '#0A0B0D' }}>
      {/* Top bar */}
      <div
        className="sticky top-0 z-50 backdrop-blur-md px-6 py-3 flex items-center justify-between"
        style={{ background: 'rgba(10,11,13,0.85)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-center gap-6">
          {/* Logo + studio name */}
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: `linear-gradient(135deg, ${primary}, ${primary}cc)` }}
            >
              <span className="text-white text-xs font-bold font-display">F</span>
            </div>
            <div className="hidden sm:block">
              <p className="text-xs text-white font-medium leading-tight">{studioName || 'FCA Studio'}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider"
                  style={{ background: badge.bg, color: badge.color }}
                >
                  {badge.label}
                </span>
              </div>
            </div>
          </div>

          {/* Nav tabs */}
          <nav className="flex items-center gap-1">
            {navItems.map(({ path, label, Icon }) => {
              const active = location.pathname === path
              return (
                <Link
                  key={path}
                  to={path}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all duration-200"
                  style={{
                    color: active ? '#fff' : '#64748b',
                    background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
                  }}
                >
                  <Icon size={14} style={{ color: active ? primary : '#64748b' }} />
                  {label}
                </Link>
              )
            })}
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <span className="hidden sm:block text-[10px] text-slate-600">{email}</span>
          <button
            onClick={signOut}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-slate-400
                       hover:text-white hover:bg-white/5 transition-all"
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </div>

      {/* Page content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        {children}
      </div>
    </div>
  )
}

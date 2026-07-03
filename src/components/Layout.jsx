import { useApp } from '../context/AppContext'
import { useAuth } from '../hooks/useAuth'
import { useLocation, Link } from 'react-router-dom'
import { LogOut, Palette, LayoutGrid, Image as ImageIcon, User, Film } from 'lucide-react'

export default function Layout({ children }) {
  const { email, role, studioName, brandColorPrimary } = useApp()
  const { signOut } = useAuth()
  const location = useLocation()

  const primary = brandColorPrimary || '#667eea'
  const isOwner = role === 'studio_owner'

  const roleBadge = {
    studio_owner: { label: 'Owner', bg: '#059669', color: '#fff' },
    studio_instructor: { label: 'Instructor', bg: '#8b5cf6', color: '#fff' },
    individual: { label: 'Member', bg: '#3b82f6', color: '#fff' },
  }
  const badge = roleBadge[role] || { label: role || '—', bg: '#64748b', color: '#fff' }

  const navItems = [
    { path: '/deliveries', label: 'Content', Icon: LayoutGrid, show: true },
    { path: '/reels', label: 'Reels', Icon: Film, show: isOwner },
    { path: '/photos', label: 'Photos', Icon: ImageIcon, show: isOwner },
    { path: '/brand', label: 'Brand', Icon: Palette, show: isOwner },
    { path: '/settings/account', label: 'Account', Icon: User, show: true },
  ].filter(n => n.show)

  return (
    <div className="min-h-screen" style={{ background: '#0A0B0D' }}>
      {/* ── Nav bar ── */}
      <nav
        className="sticky top-0 z-50"
        style={{ background: '#0A0B0D' }}
      >
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between" style={{ height: 52 }}>
          {/* Left: Logo + nav */}
          <div className="flex items-center gap-6">
            {/* Owl logo + FCA wordmark */}
            <Link to="/deliveries" className="flex items-center gap-2.5 group">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center overflow-hidden flex-shrink-0"
                style={{ background: 'linear-gradient(135deg, var(--brand-primary), var(--brand-secondary))' }}>
                <span className="text-white text-[11px] font-black font-display">F</span>
              </div>
              <span
                className="text-white text-lg tracking-wider hidden sm:block group-hover:opacity-80 transition-opacity"
                style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: '0.08em' }}
              >
                FCA
              </span>
            </Link>

            {/* Nav tabs */}
            <div className="flex items-center gap-0.5">
              {navItems.map(({ path, label, Icon }) => {
                const active = location.pathname === path
                return (
                  <Link
                    key={path}
                    to={path}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all duration-150"
                    style={{
                      color: active ? '#fff' : '#4a5568',
                      background: active ? 'rgba(255,255,255,0.07)' : 'transparent',
                    }}
                  >
                    <Icon size={13} style={{ color: active ? primary : '#4a5568' }} />
                    {label}
                  </Link>
                )
              })}
            </div>
          </div>

          {/* Right: Studio name + role + sign out */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2">
              <span className="text-[11px] text-slate-400 font-medium">{studioName || ''}</span>
              <span
                className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider"
                style={{ background: badge.bg, color: badge.color }}
              >
                {badge.label}
              </span>
            </div>
            <button
              onClick={signOut}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-slate-500 hover:text-white hover:bg-white/5 transition-all"
            >
              <LogOut size={13} />
              <span className="hidden sm:inline">Out</span>
            </button>
          </div>
        </div>

        {/* Brand color accent line — reads live from CSS var, updates instantly when studio switches */}
        <div className="h-px w-full" style={{ background: 'linear-gradient(90deg, transparent, var(--brand-primary), transparent)' }} />
      </nav>

      {/* ── Page content — directly on dark background ── */}
      <main className="max-w-5xl mx-auto px-6 py-8">
        {children}
      </main>
    </div>
  )
}

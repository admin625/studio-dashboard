import { useRef, useState, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useAuth } from '../hooks/useAuth'
import { useLocation, Link } from 'react-router-dom'
import { LogOut, Palette, LayoutGrid, Image as ImageIcon, User, Film, CalendarDays, ChevronRight, ChevronLeft } from 'lucide-react'
import { NAV_BG, NAV_INACTIVE, NAV_ACTIVE, NAV_ACTIVE_PILL, NAV_LABEL_SIZE } from '../lib/navColors'
import { usePhoneWidth, PHONE_TAB_BAR_PX, useReportBottomBar } from '../lib/viewport'
import { useAnyModalOpen } from '../lib/modalOpen'

export default function Layout({ children }) {
  const { email, role, studioName, brandColorPrimary, authReady } = useApp()
  const { signOut } = useAuth()
  const location = useLocation()

  const primary = brandColorPrimary || '#667eea'
  // UX ruling 2c: on a phone the six tabs move to a bottom bar where all of them fit (the top row
  // needed ~570px at 390px and hid Reels/Photos/Brand/Account behind a swipe). One nav is rendered
  // at a time, so no link is duplicated for screen readers.
  const phone = usePhoneWidth()
  // The bar is fixed at z-50, the same layer as the slot sheet and New Reel modal, and comes after
  // them in the DOM, so it painted over their bottom 56px ("Skip this one"). It steps aside while
  // any modal is open (2c review).
  const modalOpen = useAnyModalOpen()
  const showBar = phone && !modalOpen
  useReportBottomBar(showBar)
  // 2b — gate owner-only nav on authReady.
  const isOwner = authReady && role === 'studio_owner'

  const roleBadge = {
    studio_owner: { label: 'Owner', bg: '#059669', color: '#fff' },
    studio_instructor: { label: 'Instructor', bg: '#8b5cf6', color: '#fff' },
    individual: { label: 'Member', bg: '#3b82f6', color: '#fff' },
  }
  const badge = roleBadge[role] || { label: role || '—', bg: '#64748b', color: '#fff' }

  const navItems = [
    { path: '/deliveries', label: 'Content', Icon: LayoutGrid, show: true },
    // Owner-only: the calendar endpoint gates at level 'owner', and calendar RLS keys on
    // owned_studio_ids(). Showing it to an instructor would render a tab that 403s.
    { path: '/calendar', label: 'Plan', Icon: CalendarDays, show: isOwner },
    { path: '/reels', label: 'Reels', Icon: Film, show: isOwner },
    { path: '/photos', label: 'Photos', Icon: ImageIcon, show: isOwner },
    { path: '/brand', label: 'Brand', Icon: Palette, show: isOwner },
    { path: '/settings/account', label: 'Account', Icon: User, show: true },
  ].filter(n => n.show)

  // PR-4: the tab row scrolls inside the nav instead of widening the page. At 390px the six owner tabs
  // need ~430px; before this the whole page scrolled sideways and Photos / Brand / Account sat off-screen.
  // moreLeft / moreRight drive the edge fades + chevrons — the visible hint that there is more to swipe to.
  const tabsRef = useRef(null)
  const [moreLeft, setMoreLeft] = useState(false)
  const [moreRight, setMoreRight] = useState(false)
  const measure = useCallback(() => {
    const el = tabsRef.current
    if (!el) return
    setMoreLeft(el.scrollLeft > 2)
    setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  }, [])
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    // Bring the current tab into view — an owner on /settings/account must not land with it scrolled away.
    const current = el.querySelector('[aria-current="page"]')
    if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [location.pathname, navItems.length, measure, phone])

  return (
    <div className="min-h-screen" style={{ background: NAV_BG }}>
      {/* ── Nav bar ── */}
      <nav
        aria-label={phone ? 'Studio' : 'Main'}
        className="sticky top-0 z-50"
        style={{ background: NAV_BG }}
      >
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between gap-3" style={{ height: 52 }}>
          {/* Left: Logo + nav. min-w-0 lets the tab row shrink and scroll instead of pushing the page wider. */}
          <div className="flex items-center gap-4 sm:gap-6 min-w-0 flex-1">
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

            {/* On a phone: the studio's name here; the tabs are in the bottom bar. */}
            {phone && <span className="min-w-0 truncate text-[13px] text-slate-300 font-medium">{studioName || ''}</span>}

            {/* Nav tabs — scroll within the nav (PR-4). Desktop / tablet only (2c). */}
            {!phone && (
            <div className="relative min-w-0 flex-1">
            <div ref={tabsRef} onScroll={measure} data-testid="nav-tabs"
              className="nav-scroll flex items-center gap-0.5 overflow-x-auto">
              {navItems.map(({ path, label, Icon }) => {
                const active = location.pathname === path
                return (
                  <Link
                    key={path}
                    to={path}
                    aria-current={active ? 'page' : undefined}
                    className={`flex flex-shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-md ${NAV_LABEL_SIZE} font-semibold uppercase tracking-wider whitespace-nowrap transition-all duration-150 hover:text-white`}
                    style={{
                      // PR-3: inactive was #4a5568 (2.62:1); now NAV_INACTIVE (7.68:1, WCAG AA). Active stays
                      // distinct three ways: white text, a tinted pill, and a brand-coloured icon + underline.
                      color: active ? NAV_ACTIVE : NAV_INACTIVE,
                      background: active ? NAV_ACTIVE_PILL : 'transparent',
                      boxShadow: active ? `inset 0 -2px 0 ${primary}` : 'none',
                    }}
                  >
                    <Icon size={13} style={{ color: active ? primary : NAV_INACTIVE }} />
                    {label}
                  </Link>
                )
              })}
            </div>
            {moreLeft && (
              <div aria-hidden="true" data-testid="nav-more-left"
                className="pointer-events-none absolute left-0 top-0 h-full w-8 flex items-center justify-start"
                style={{ background: `linear-gradient(to right, ${NAV_BG} 35%, transparent)` }}>
                <ChevronLeft size={14} style={{ color: NAV_INACTIVE }} />
              </div>
            )}
            {moreRight && (
              <div aria-hidden="true" data-testid="nav-more-right"
                className="pointer-events-none absolute right-0 top-0 h-full w-10 flex items-center justify-end"
                style={{ background: `linear-gradient(to left, ${NAV_BG} 35%, transparent)` }}>
                <ChevronRight size={14} style={{ color: NAV_INACTIVE }} />
              </div>
            )}
            </div>
            )}
          </div>

          {/* Right: Studio name + role + sign out (never shrinks; the tab row gives way instead) */}
          <div className="flex flex-shrink-0 items-center gap-3">
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
              className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 min-w-[44px] min-h-[44px] rounded-md text-[11px] font-medium hover:text-white hover:bg-white/5 transition-all"
              style={{ color: NAV_INACTIVE }}
              aria-label="Sign out"
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
      {/* pb on a phone clears the bottom bar and the help bubble above it, so the last thing on a
          page can scroll into view instead of sitting under them. */}
      <main className={`max-w-5xl mx-auto px-6 pt-8 ${phone ? 'pb-36' : 'pb-8'}`}>
        {children}
      </main>

      {/* ── Phone: bottom tab bar (2c) ── */}
      {/* z-40: below every modal layer (z-50 sheets, z-100 overlays), as a second guard. */}
      {showBar && (
        <nav aria-label="Main" data-testid="nav-bottom"
          className="fixed bottom-0 inset-x-0 z-40"
          style={{ background: NAV_BG, borderTop: '1px solid rgba(255,255,255,0.08)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))` }}>
            {navItems.map(({ path, label, Icon }) => {
              const active = location.pathname === path
              return (
                <Link key={path} to={path} aria-current={active ? 'page' : undefined}
                  className="flex flex-col items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ minHeight: PHONE_TAB_BAR_PX, color: active ? NAV_ACTIVE : NAV_INACTIVE, boxShadow: active ? `inset 0 2px 0 ${primary}` : 'none' }}>
                  <Icon size={18} style={{ color: active ? primary : NAV_INACTIVE }} />
                  {label}
                </Link>
              )
            })}
          </div>
        </nav>
      )}
    </div>
  )
}

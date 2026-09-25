import { useState, useEffect } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useApp } from '../context/AppContext'
import { Loader2 } from 'lucide-react'
import { landingPath, allowedNextOrNull, withNext } from '../lib/deepLink'
import { SIGN_IN_LINK_MESSAGES } from '../lib/signInLink'

export default function Login() {
  const { login, sendSignInLink } = useAuth()
  const { user, authReady, role } = useApp()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // AG-1.4 Part 1. linkState: null | 'sending' | 'sent' | 'rate_limited' | 'error' | 'need_email'.
  const [linkState, setLinkState] = useState(null)

  // Redirect once authenticated, to whatever ProtectedRoute put in ?next=.
  // No next means the role default — /calendar for an owner, /deliveries otherwise.
  useEffect(() => {
    if (authReady && user) {
      // Destination rides in our own query string. Allowlist-validated on read inside
      // landingPath; it never returns null, so there is no fallback to forget.
      //
      // The RESOLVED app role, with no fallback to the raw claim. AuthProvider already
      // prefers the JWT role when it sets this, so the only case `role` is null is a
      // failed resolution — and an account whose studio could not be resolved has no
      // business being sent to /calendar on the strength of a claim alone. Null lands
      // her on DEFAULT_PATH, which is the honest answer for a session we cannot place.
      // Set in the same state update as `user`, so there is nothing to race.
      navigate(landingPath(location.search, role), { replace: true })
    }
  }, [authReady, user, role, navigate, location.search])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!email || !password) return
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      // AuthProvider will set user + authReady via onAuthStateChange
      // The useEffect above will redirect once user is set
    } catch (err) {
      setError(err.message || 'Login failed')
      setLoading(false)
    }
    // Don't setLoading(false) on success — keep spinner until redirect
  }

  // A first-class way back in without a password (AG-1.4 Part 1). Most studios never set one:
  // provisioning signs them in by magic link. The destination rides the callback exactly as it
  // does from /forgot-password — allowedNextOrNull, never a laundered default.
  const handleSignInLink = async () => {
    if (!email.trim()) { setLinkState('need_email'); return }
    setError('')
    setLinkState('sending')
    setLinkState(await sendSignInLink(email.trim(), allowedNextOrNull(location.search)))
  }

  // If already authenticated, show nothing (redirect is happening)
  if (authReady && user) return null

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#0A0B0D' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-6"
            style={{ background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-secondary) 100%)' }}
          >
            <span className="text-white text-xl font-bold font-display">F</span>
          </div>
          <h1
            className="text-white mb-2"
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: 'clamp(2rem, 5vw, 2.8rem)',
              letterSpacing: '0.03em',
              lineHeight: 1,
            }}
          >
            FCA Studio
          </h1>
          <p className="text-slate-300 text-sm">Sign in to your dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold tracking-wider uppercase text-slate-400 mb-2">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@studio.com"
              autoComplete="email"
              required
              className="w-full px-4 py-3.5 rounded-xl text-sm text-white placeholder-slate-600
                         focus:outline-none focus:ring-2 transition-all"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', outlineColor: 'var(--brand-primary)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold tracking-wider uppercase text-slate-400 mb-2">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              required
              className="w-full px-4 py-3.5 rounded-xl text-sm text-white placeholder-slate-600
                         focus:outline-none focus:ring-2 transition-all"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', outlineColor: 'var(--brand-primary)' }}
            />
          </div>

          {error && (
            <div className="px-4 py-3 rounded-lg text-sm text-red-300" style={{ background: 'rgba(239,68,68,0.1)' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2.5 py-4 rounded-xl text-sm font-bold
                       uppercase tracking-wider transition-all duration-200
                       disabled:opacity-60 disabled:cursor-not-allowed
                       hover:-translate-y-0.5 active:translate-y-0"
            style={{
              background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-secondary) 100%)',
              color: 'white',
              boxShadow: '0 4px 20px color-mix(in srgb, var(--brand-primary) 40%, transparent)',
            }}
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <div className="mt-4">
          <div className="flex items-center gap-3 mb-4" aria-hidden="true">
            <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.08)' }} />
            <span className="text-[11px] uppercase tracking-wider text-slate-500">or</span>
            <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.08)' }} />
          </div>
          <button
            type="button"
            onClick={handleSignInLink}
            disabled={linkState === 'sending'}
            className="w-full flex items-center justify-center gap-2.5 py-3.5 rounded-xl text-sm font-semibold
                       text-white transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' }}
          >
            {linkState === 'sending' && <Loader2 size={16} className="animate-spin" />}
            {linkState === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
          </button>
          {linkState && linkState !== 'sending' && (
            <p
              role="status"
              className={`mt-3 px-4 py-3 rounded-lg text-sm ${linkState === 'sent' ? 'text-emerald-300' : linkState === 'error' ? 'text-red-300' : 'text-amber-200'}`}
              style={{ background: linkState === 'sent' ? 'rgba(16,185,129,0.1)' : linkState === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)' }}
            >
              {SIGN_IN_LINK_MESSAGES[linkState]}
            </p>
          )}
        </div>

        <p className="text-center mt-6 text-xs text-slate-500">
          Forgot password?{' '}
          {/* allowedNextOrNull, not nextPathFromQuery: the latter turns "no destination"
              into DEFAULT_PATH, and withNext can no longer tell those apart now that the
              landing is role-dependent. Laundering it here would pin every magic link to
              /deliveries and quietly cancel the owner default. */}
          <Link to={withNext('/forgot-password', allowedNextOrNull(location.search))} className="transition-colors" style={{ color: 'var(--brand-primary)' }}>
            Reset it here
          </Link>
        </p>
      </div>
    </div>
  )
}

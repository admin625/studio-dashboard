import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { nextPathFromQuery } from '../lib/deepLink'

export default function ForgotPassword() {
  const { loginWithMagicLink, loading } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e?.preventDefault?.()
    if (!email) return
    setError(null)
    // Carry the destination the studio was originally headed for into the email.
    const { ok, error } = await loginWithMagicLink(email, nextPathFromQuery(location.search))
    if (ok) setSubmitted(true)
    else setError(error)
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#0A0B0D' }}>
        <div className="w-full max-w-sm text-center">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-6"
            style={{ background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-secondary) 100%)' }}
          >
            <span className="text-white text-xl font-bold font-display">F</span>
          </div>
          <h1
            className="text-white mb-3"
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: 'clamp(2rem, 5vw, 2.8rem)',
              letterSpacing: '0.03em',
              lineHeight: 1,
            }}
          >
            Check your email
          </h1>
          <p className="text-slate-300 text-sm leading-relaxed mb-8">
            If an account exists for <span className="text-white">{email}</span>, a magic link is on its way. Check your inbox (and spam folder, just in case).
          </p>
          <Link
            to="/login"
            className="text-xs uppercase tracking-wider transition-colors"
            style={{ color: 'var(--brand-primary)' }}
          >
            ← Back to login
          </Link>
        </div>
      </div>
    )
  }

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
            Magic link login
          </h1>
          <p className="text-slate-300 text-sm">Enter your email and we'll send you a one-click login link.</p>
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
              disabled={loading}
              className="w-full px-4 py-3.5 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 transition-all"
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
            disabled={loading || !email}
            className="w-full flex items-center justify-center gap-2.5 py-4 rounded-xl text-sm font-bold uppercase tracking-wider transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed hover:-translate-y-0.5 active:translate-y-0"
            style={{
              background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-secondary) 100%)',
              color: 'white',
              boxShadow: '0 4px 20px color-mix(in srgb, var(--brand-primary) 40%, transparent)',
            }}
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {loading ? 'Sending…' : 'Send magic link'}
          </button>
        </form>

        <p className="text-center mt-6 text-xs text-slate-500">
          <Link to="/login" className="transition-colors" style={{ color: 'var(--brand-primary)' }}>
            ← Back to login
          </Link>
        </p>
      </div>
    </div>
  )
}

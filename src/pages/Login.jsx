import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useApp } from '../context/AppContext'
import { Loader2 } from 'lucide-react'

export default function Login() {
  const { login } = useAuth()
  const { user, authReady } = useApp()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Redirect to dashboard if already authenticated
  useEffect(() => {
    if (authReady && user) {
      navigate('/deliveries', { replace: true })
    }
  }, [authReady, user, navigate])

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
          <p className="text-slate-500 text-sm">Sign in to your dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold tracking-wider uppercase text-slate-500 mb-2">
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
            <label className="block text-xs font-semibold tracking-wider uppercase text-slate-500 mb-2">
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
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="text-center mt-6 text-xs text-slate-600">
          Forgot password?{' '}
          <a href="#/forgot-password" className="transition-colors" style={{ color: 'var(--brand-primary)' }}>
            Reset it here
          </a>
        </p>
      </div>
    </div>
  )
}

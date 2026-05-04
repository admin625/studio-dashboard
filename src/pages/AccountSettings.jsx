import { useState } from 'react'
import { Mail, Lock, LogOut, Loader2 } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import Layout from '../components/Layout'

export default function AccountSettings() {
  const { user, brandColorPrimary } = useApp()
  const { signOut } = useAuth()
  const primary = brandColorPrimary || '#667eea'

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [status, setStatus] = useState(null)
  const [saving, setSaving] = useState(false)

  const handleSetPassword = async () => {
    setStatus(null)
    if (password.length < 8) {
      setStatus({ type: 'error', msg: 'Password must be at least 8 characters.' })
      return
    }
    if (password !== confirm) {
      setStatus({ type: 'error', msg: 'Passwords do not match.' })
      return
    }
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password })
    setSaving(false)
    if (error) {
      setStatus({ type: 'error', msg: error.message })
    } else {
      setStatus({ type: 'success', msg: 'Password set. You can now log in with email + password.' })
      setPassword('')
      setConfirm('')
    }
  }

  return (
    <Layout>
      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-6 h-px" style={{ background: primary }} />
          <span className="text-[10px] font-semibold tracking-[0.2em] uppercase" style={{ color: primary }}>Settings</span>
        </div>
        <h1 className="text-white" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 'clamp(1.8rem, 4vw, 2.6rem)', letterSpacing: '0.02em' }}>
          Account
        </h1>
      </div>

      {/* Email */}
      <section className="mb-6 rounded-xl p-5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2 mb-3">
          <Mail size={14} style={{ color: primary }} />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Email</h2>
        </div>
        <p className="text-white text-sm">{user?.email || '—'}</p>
      </section>

      {/* Set password */}
      <section className="mb-6 rounded-xl p-5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2 mb-3">
          <Lock size={14} style={{ color: primary }} />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Set a password</h2>
        </div>
        <p className="text-slate-300 text-sm mb-4">
          Optional. Set a password if you'd prefer to log in with email + password instead of magic link.
        </p>
        <div className="space-y-3 max-w-sm">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="New password"
            autoComplete="new-password"
            disabled={saving}
            className="w-full px-4 py-3 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 transition-all"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', outlineColor: 'var(--brand-primary)' }}
          />
          <input
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            placeholder="Confirm password"
            autoComplete="new-password"
            disabled={saving}
            className="w-full px-4 py-3 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 transition-all"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', outlineColor: 'var(--brand-primary)' }}
          />
          <button
            onClick={handleSetPassword}
            disabled={saving || !password || !confirm}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5"
            style={{
              background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-secondary) 100%)',
              color: 'white',
            }}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? 'Saving…' : 'Set password'}
          </button>
          {status && (
            <div
              className="px-4 py-3 rounded-lg text-xs"
              style={{
                background: status.type === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)',
                color: status.type === 'error' ? '#fca5a5' : '#6ee7b7',
              }}
            >
              {status.msg}
            </div>
          )}
        </div>
      </section>

      {/* Sign out */}
      <section className="rounded-xl p-5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2 mb-3">
          <LogOut size={14} className="text-slate-400" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Sign out</h2>
        </div>
        <p className="text-slate-300 text-sm mb-4">End your current session on this device.</p>
        <button
          onClick={signOut}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-medium text-slate-300 hover:text-white hover:bg-white/5 transition-all"
          style={{ border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <LogOut size={13} />
          Sign out
        </button>
      </section>
    </Layout>
  )
}

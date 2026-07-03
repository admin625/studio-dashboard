/**
 * Reels — Reel Editor review page (D2).
 * Lists the studio's reels (reel_edls) via the service-role `reels` function (reel_edls is RLS-locked
 * to the anon key). Reviewer approves a proposed reel -> authenticated WF2 render fires -> the row goes
 * rendering -> the Render Reconciler delivers a playable MP4 (~1 tick, 60s cron). The page polls and
 * surfaces: in-progress after approve, the finished reel when delivered, or a failure state.
 */
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import Layout from '../components/Layout'
import { Loader2, CheckCircle2, AlertTriangle, Film, Sparkles } from 'lucide-react'

// render_status terminal classification
const FAIL_STATES = { render_failed: 'Render failed', render_timeout: 'Render timed out', delivery_failed: 'Delivery failed' }
const isMidFlight = (r) =>
  (r.status === 'approved' && (!r.render_status || r.render_status === 'rendering' || r.render_status === 'delivering'))

async function callReels(action, payload) {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  const res = await fetch('/.netlify/functions/reels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') },
    body: JSON.stringify({ action, ...payload }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status))
  return json
}

export default function Reels() {
  const app = useApp()
  const primary = app.brandColorPrimary || '#667eea'
  const studioId = app.resolvedStudioId

  const [reels, setReels] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState({})

  const load = useCallback(async () => {
    if (!studioId) return
    try {
      const { reels } = await callReels('list', { studio_id: studioId })
      setReels(Array.isArray(reels) ? reels : [])
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [studioId])

  useEffect(() => { load() }, [load])

  // Poll every 15s while any reel is mid-flight (approved but not yet delivered/failed).
  // The reconciler updates on a 60s cron, so this reflects the transition without a manual reload.
  useEffect(() => {
    if (!reels.some(isMidFlight)) return
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [reels, load])

  const approve = async (reel) => {
    setBusy((b) => ({ ...b, [reel.reel_id]: true }))
    setError(null)
    try {
      await callReels('approve', { reel_id: reel.reel_id })
      setReels((rs) => rs.map((r) => (r.reel_id === reel.reel_id ? { ...r, status: 'approved', render_status: 'rendering' } : r)))
      setTimeout(load, 3000)
    } catch (e) {
      setError(e.message)
      load()
    } finally {
      setBusy((b) => ({ ...b, [reel.reel_id]: false }))
    }
  }

  if (loading) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin mb-4" style={{ color: primary }} />
          <p className="text-slate-400 text-sm">Loading reels…</p>
        </div>
      </Layout>
    )
  }

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center gap-2.5 mb-6">
          <Film size={20} style={{ color: primary }} />
          <h1 className="text-white text-xl font-semibold">Reels</h1>
        </div>

        {error && (
          <div className="mb-5 rounded-lg px-4 py-3 text-sm" style={{ background: 'rgba(239,68,68,0.1)', color: '#fca5a5' }}>
            {error}
          </div>
        )}

        {reels.length === 0 ? (
          <div className="text-center py-20">
            <Film size={40} className="mx-auto mb-4" style={{ color: 'rgba(255,255,255,0.12)' }} />
            <p className="text-white text-base font-semibold mb-1">No reels yet</p>
            <p className="text-slate-400 text-sm">Reels appear here once the content agent builds one for your studio.</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {reels.map((reel) => (
              <ReelCard key={reel.reel_id} reel={reel} primary={primary} busy={!!busy[reel.reel_id]} onApprove={() => approve(reel)} />
            ))}
          </div>
        )}
      </div>
    </Layout>
  )
}

function ReelCard({ reel, primary, busy, onApprove }) {
  const failLabel = FAIL_STATES[reel.render_status]
  const delivered = reel.render_status === 'delivered' && reel.render_url
  const pending = reel.status === 'pending_approval'
  const rendering = isMidFlight(reel)

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-white text-sm font-semibold leading-snug">{reel.hook || 'Reel'}</p>
            <p className="text-slate-500 text-xs mt-1">
              {reel.clip_count != null ? `${reel.clip_count} clips` : ''}
              {reel.duration_s != null ? ` · ~${reel.duration_s}s` : ''}
              {reel.created_at ? ` · ${new Date(reel.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
            </p>
          </div>
          <StatusPill reel={reel} primary={primary} />
        </div>

        {/* State body */}
        <div className="mt-4">
          {delivered && (
            <div>
              <video src={reel.render_url} controls playsInline className="w-full rounded-lg bg-black" style={{ maxHeight: 520 }} />
              <div className="flex items-center gap-1.5 mt-2 text-xs" style={{ color: '#34d399' }}>
                <CheckCircle2 size={14} /> Delivered
              </div>
            </div>
          )}

          {rendering && (
            <div className="flex items-center gap-2.5 rounded-lg px-4 py-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <Loader2 size={16} className="animate-spin" style={{ color: primary }} />
              <span className="text-slate-300 text-sm">Rendering your reel… this usually takes a minute.</span>
            </div>
          )}

          {failLabel && (
            <div className="flex items-center gap-2 rounded-lg px-4 py-3 text-sm" style={{ background: 'rgba(239,68,68,0.08)', color: '#fca5a5' }}>
              <AlertTriangle size={15} /> {failLabel}. The team has been notified — try again shortly.
            </div>
          )}

          {pending && (
            <button
              onClick={onApprove}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-60"
              style={{ background: primary }}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {busy ? 'Approving…' : 'Approve & Render'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusPill({ reel, primary }) {
  let label = reel.status
  let color = '#94a3b8'
  let bg = 'rgba(148,163,184,0.12)'
  if (reel.render_status === 'delivered') { label = 'Delivered'; color = '#34d399'; bg = 'rgba(52,211,153,0.12)' }
  else if (FAIL_STATES[reel.render_status]) { label = 'Failed'; color = '#fca5a5'; bg = 'rgba(239,68,68,0.12)' }
  else if (isMidFlight(reel)) { label = 'Rendering'; color = primary; bg = 'rgba(255,255,255,0.06)' }
  else if (reel.status === 'pending_approval') { label = 'Ready to review'; color = '#fbbf24'; bg = 'rgba(251,191,36,0.12)' }
  return (
    <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full" style={{ color, background: bg }}>
      {label}
    </span>
  )
}

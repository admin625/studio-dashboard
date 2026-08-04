/**
 * Reels — Reel Editor page (B2 create + D2 review + delivery).
 * Lists the studio's reels (reel_edls) via the service-role `reels` function (reel_edls is RLS-locked
 * to the anon key). "New Reel" opens the in-session create flow (upload + params -> WF1). Active reels
 * (Ready-to-review / Rendering) stay expanded up top: the reviewer may edit the hook, then Generate
 * Reel -> the edit is folded into the EDL (moat signal) and WF2 fires -> Rendering -> the reconciler
 * delivers a playable MP4. Delivered reels collapse to compact rows; the <video> mounts only on expand
 * (no bytes fetched while collapsed). render_url is signed at list-load and read directly by the row.
 */
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import Layout from '../components/Layout'
import NewReelModal from '../components/NewReelModal'
import { Loader2, AlertTriangle, Film, Sparkles, Plus, ChevronDown } from 'lucide-react'

// render_status terminal classification
const FAIL_STATES = { render_failed: 'Render failed', render_timeout: 'Render timed out', delivery_failed: 'Delivery failed' }
const isMidFlight = (r) =>
  (r.status === 'approved' && (!r.render_status || r.render_status === 'rendering' || r.render_status === 'delivering'))

// Ordering. The old split was `active = render_status !== 'delivered'`, which put BOTH terminal
// failure kinds in the same bucket as work-in-progress and rendered them above the delivered
// list. A failed reel therefore outranked every successful one permanently, with no way to
// clear it — on 2026-08-04 a delivered render sat unnoticed below two dead failure cards for
// twenty minutes. Failures are the least actionable thing on the page and must sort LAST.
//
// Change GROUP_ORDER to reorder the page; nothing else needs to move.
const GROUP_ORDER = ['pending', 'rendering', 'delivered', 'failed']
const GROUP_HEADING = { pending: null, rendering: null, delivered: 'Delivered', failed: "Didn't work" }

function reelGroup(r) {
  if (r.render_status === 'delivered') return 'delivered'
  if (r.status === 'validation_failed' || FAIL_STATES[r.render_status]) return 'failed'
  if (isMidFlight(r)) return 'rendering'
  return 'pending'
}

const byRecency = (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)

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
  const [showNew, setShowNew] = useState(false)
  const [awaitingReelId, setAwaitingReelId] = useState(null)

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
  useEffect(() => {
    if (!reels.some(isMidFlight)) return
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [reels, load])

  // After creating a reel, poll until WF1 persists it (it appears in the list), then stop (90s cap).
  useEffect(() => {
    if (!awaitingReelId) return
    if (reels.some((r) => r.reel_id === awaitingReelId)) { setAwaitingReelId(null); return }
    const t = setInterval(load, 5000)
    const stop = setTimeout(() => setAwaitingReelId(null), 90000)
    return () => { clearInterval(t); clearTimeout(stop) }
  }, [awaitingReelId, reels, load])

  const approve = async (reel, hookText) => {
    setBusy((b) => ({ ...b, [reel.reel_id]: true }))
    setError(null)
    try {
      await callReels('approve', { reel_id: reel.reel_id, hook_text: hookText })
      setReels((rs) => rs.map((r) => (r.reel_id === reel.reel_id ? { ...r, status: 'approved', render_status: 'rendering' } : r)))
      setTimeout(load, 3000)
    } catch (e) {
      setError(e.message)
      load()
    } finally {
      setBusy((b) => ({ ...b, [reel.reel_id]: false }))
    }
  }

  const newReelButton = (extra) => (
    <button
      onClick={() => setShowNew(true)}
      disabled={!studioId}
      className={'flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60 ' + (extra || '')}
      style={{ background: primary }}
    >
      <Plus size={15} /> New Reel
    </button>
  )

  const modal = showNew && (
    <NewReelModal
      studioId={studioId}
      primary={primary}
      onClose={() => setShowNew(false)}
      onCreated={(rid) => { setShowNew(false); setAwaitingReelId(rid); load() }}
    />
  )

  if (loading) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin mb-4" style={{ color: primary }} />
          <p className="text-slate-400 text-sm">Loading reels…</p>
        </div>
        {modal}
      </Layout>
    )
  }

  const groups = GROUP_ORDER.map((g) => ({
    key: g,
    heading: GROUP_HEADING[g],
    reels: reels.filter((r) => reelGroup(r) === g).sort(byRecency),
  })).filter((g) => g.reels.length > 0)

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2.5">
            <Film size={20} style={{ color: primary }} />
            <h1 className="text-white text-xl font-semibold">Reels</h1>
          </div>
          {newReelButton()}
        </div>

        {error && (
          <div className="mb-5 rounded-lg px-4 py-3 text-sm" style={{ background: 'rgba(239,68,68,0.1)', color: '#fca5a5' }}>
            {error}
          </div>
        )}

        {awaitingReelId && (
          <div className="mb-5 flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm" style={{ background: 'rgba(255,255,255,0.03)', color: '#cbd5e1' }}>
            <Loader2 size={15} className="animate-spin" style={{ color: primary }} />
            Creating your reel… it'll appear here in a moment.
          </div>
        )}

        {groups.length === 0 ? (
          <div className="text-center py-20">
            <Film size={40} className="mx-auto mb-4" style={{ color: 'rgba(255,255,255,0.12)' }} />
            <p className="text-white text-base font-semibold mb-1">No reels yet</p>
            <p className="text-slate-400 text-sm mb-5">Create one from your own clips, or reels appear here once the content agent builds one for your studio.</p>
            <div className="flex justify-center">{newReelButton()}</div>
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.key} className="mb-8 last:mb-0">
                {group.heading && (
                  <h2 className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-3">{group.heading}</h2>
                )}
                <div className={group.key === 'delivered' ? 'grid gap-2' : 'grid gap-4'}>
                  {group.reels.map((reel) =>
                    group.key === 'delivered' ? (
                      <DeliveredRow key={reel.reel_id} reel={reel} />
                    ) : (
                      <ReelCard key={reel.reel_id} reel={reel} primary={primary} busy={!!busy[reel.reel_id]} onApprove={(ht) => approve(reel, ht)} onNewReel={() => setShowNew(true)} />
                    )
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      {modal}
    </Layout>
  )
}

// Why an assembly failed, in the owner's terms. Reads edl.validation.flags, passed through by
// reels.js; flags are emitted by WF1 Self-Validate.
//
// This replaced a single hardcoded string used for EVERY validation_failed cause, which read
// "too dense to assemble — try a calmer pacing or a shorter target length". That advice was
// actively harmful: the reuse budget scales WITH the target, so shortening the target makes
// avoidable_clip_reuse MORE likely. It recommended the action that causes the failure.
function assemblyFailureCopy(reel) {
  const flags = reel.validation && Array.isArray(reel.validation.flags) ? reel.validation.flags : []
  const has = (prefix) => flags.some((f) => typeof f === 'string' && f.startsWith(prefix))

  if (has('avoidable_clip_reuse'))
    return 'This edit repeated the same footage more than it needed to. Add another clip, or try a longer target length.'
  if (has('clip_no_probe') || has('inout_oob'))
    return "We couldn't read one of your clips. Try re-uploading it, then create the reel again."
  if (has('edl_json_parse_failed') || has('opus_call_error'))
    return "We couldn't generate a plan for this reel. Try again — this one is usually temporary."
  if (has('structure_invalid') || has('timeline_gap') || has('sum_ne_target'))
    return "We couldn't assemble a valid edit from these clips. Try again."
  return "We couldn't assemble this reel. Try again, or add another clip."
}

// Active (non-delivered) reel: Ready-to-review (editable hook + Generate Reel), Rendering, Failed, or
// Couldn't-assemble (status='validation_failed' — WF1 could not produce a valid EDL, e.g. truncation).
function ReelCard({ reel, primary, busy, onApprove, onNewReel }) {
  const [hookText, setHookText] = useState(reel.hook || '')
  const failLabel = FAIL_STATES[reel.render_status]
  const failedAssembly = reel.status === 'validation_failed'
  const pending = reel.status === 'pending_approval'
  const rendering = isMidFlight(reel)

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-white text-sm font-semibold leading-snug">{reel.hook || 'Reel'}</p>
            <p className="text-slate-500 text-xs mt-1">
              {failedAssembly
                ? (reel.created_at ? new Date(reel.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '')
                : `${reel.clip_count != null ? `${reel.clip_count} clips` : ''}${reel.duration_s != null ? ` · ~${reel.duration_s}s` : ''}${reel.created_at ? ` · ${new Date(reel.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}`}
            </p>
          </div>
          <StatusPill reel={reel} primary={primary} />
        </div>

        <div className="mt-4">
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

          {failedAssembly && (
            <div>
              <div className="flex items-start gap-2 rounded-lg px-4 py-3 text-sm mb-3" style={{ background: 'rgba(239,68,68,0.08)', color: '#fca5a5' }}>
                <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
                <span>{assemblyFailureCopy(reel)}</span>
              </div>
              <button
                onClick={onNewReel}
                className="w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white transition-opacity"
                style={{ background: primary }}
              >
                <Plus size={15} /> Start a new reel
              </button>
            </div>
          )}

          {pending && (
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5">Hook — edit before approving</label>
              <textarea
                value={hookText}
                onChange={(e) => setHookText(e.target.value)}
                rows={2}
                disabled={busy}
                className="w-full rounded-lg px-3 py-2 text-sm text-white outline-none resize-none mb-3"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
              <button
                onClick={() => onApprove(hookText)}
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-60"
                style={{ background: primary }}
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                {busy ? 'Generating…' : 'Generate Reel'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Delivered reel: compact row; the <video> mounts only on expand (no bytes fetched while collapsed).
// render_url is signed at list-load and passed in via the reel object.
function DeliveredRow({ reel }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-3 px-4 py-3 text-left">
        <span className="text-white text-sm font-medium truncate flex-1">{reel.hook || 'Reel'}</span>
        <span className="text-slate-500 text-xs whitespace-nowrap hidden sm:block">
          {reel.clip_count != null ? `${reel.clip_count} clips` : ''}
          {reel.created_at ? ` · ${new Date(reel.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
        </span>
        <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ color: '#34d399', background: 'rgba(52,211,153,0.12)' }}>
          Delivered
        </span>
        <ChevronDown size={16} className="flex-shrink-0 text-slate-400 transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      {open && (
        <div className="px-4 pb-4">
          {reel.render_url ? (
            <video src={reel.render_url} controls playsInline className="w-full rounded-lg bg-black" style={{ maxHeight: 520 }} />
          ) : (
            <div className="text-slate-500 text-sm py-2">Playback unavailable.</div>
          )}
        </div>
      )}
    </div>
  )
}

function StatusPill({ reel, primary }) {
  let label = (reel.status || 'unknown').replace(/_/g, ' ')
  let color = '#94a3b8'
  let bg = 'rgba(148,163,184,0.12)'
  if (reel.status === 'validation_failed') { label = "Couldn't assemble"; color = '#fca5a5'; bg = 'rgba(239,68,68,0.12)' }
  else if (FAIL_STATES[reel.render_status]) { label = 'Failed'; color = '#fca5a5'; bg = 'rgba(239,68,68,0.12)' }
  else if (isMidFlight(reel)) { label = 'Rendering'; color = primary; bg = 'rgba(255,255,255,0.06)' }
  else if (reel.status === 'pending_approval') { label = 'Ready to review'; color = '#fbbf24'; bg = 'rgba(251,191,36,0.12)' }
  return (
    <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full" style={{ color, background: bg }}>
      {label}
    </span>
  )
}

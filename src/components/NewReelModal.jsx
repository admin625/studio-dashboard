/**
 * NewReelModal — B2 STEP 3: authenticated "New Reel" create flow on the Reels tab.
 *
 * In-session: upload clips to reel-sources/{studio_id}/{reel_id}/… (Option-A RLS INSERT
 * gates by studio), capture the 4 WF1-honored params, assemble the manifest, and fire WF1
 * via the `reel-create-background` function (holds x-wf1-secret; 202-then-async so WF1's slow
 * chain never times out). Brand (voice/audience) is inherited read-only from studio_accounts
 * and shown, never re-asked.
 * CTA is deferred (its own spec). Stops at manifest→WF1; approve→render stays on the card (D2).
 */
import { useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import { Loader2, X, Sparkles, UploadCloud } from 'lucide-react'

const PLATFORMS = [
  { v: 'instagram_reels', l: 'Instagram Reels' },
  { v: 'tiktok', l: 'TikTok' },
  { v: 'youtube_shorts', l: 'YouTube Shorts' },
]
const ENERGIES = [
  { v: 'chill', l: 'Chill', h: 'calm, longer holds' },
  { v: 'balanced', l: 'Balanced', h: 'versatile default' },
  { v: 'hype', l: 'Hype', h: 'fast, tight cuts' },
]
const DURATIONS = [15, 30, 60]

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

export default function NewReelModal({ studioId, primary, onClose, onCreated }) {
  const app = useApp()
  const [theme, setTheme] = useState('')
  const [platform, setPlatform] = useState('instagram_reels')
  const [duration, setDuration] = useState(30)
  const [energy, setEnergy] = useState('balanced')
  const [hookDirection, setHookDirection] = useState('')
  const [files, setFiles] = useState([])
  const [phase, setPhase] = useState('') // '', 'uploading', 'submitting'
  const [error, setError] = useState(null)

  const busy = phase !== ''

  const onPick = useCallback((e) => {
    setFiles(Array.from(e.target.files || []))
    setError(null)
  }, [])

  const submit = useCallback(async () => {
    if (busy || !studioId || !files.length) return
    setError(null)
    const reelId = crypto.randomUUID()

    // 1) Upload clips to the studio's private library (RLS-scoped by studio).
    setPhase('uploading')
    const sourceClips = []
    for (let i = 0; i < files.length; i++) {
      const clipId = crypto.randomUUID()
      const path = `${studioId}/${reelId}/${String(i + 1).padStart(2, '0')}-${sanitize(files[i].name)}`
      const { error: upErr } = await supabase.storage
        .from('reel-sources')
        .upload(path, files[i], { upsert: false, contentType: files[i].type || undefined })
      if (upErr) {
        setError(`Upload failed for ${files[i].name}: ${upErr.message}`)
        setPhase('')
        return
      }
      sourceClips.push({ clip_id: clipId, storage_path: path, uploaded_order: i + 1 })
    }

    // 2) Assemble manifest + fire WF1 (server-side, x-wf1-secret held there).
    setPhase('submitting')
    const manifest = {
      manifest_version: '1.0',
      reel_id: reelId,
      studio_id: studioId,
      platform,
      target_duration_s: duration,
      energy_profile: energy,
      source_clips: sourceClips,
      allow_reuse_insufficient: false,
    }
    if (theme.trim()) manifest.theme = theme.trim()
    if (hookDirection.trim()) manifest.hook_direction = hookDirection.trim()

    try {
      const { data } = await supabase.auth.getSession()
      const token = data?.session?.access_token
      // Background function: WF1 is slow (sign->probe->Opus->persist), so firing it must not
      // block on a sync timeout. It returns 202 immediately; WF1 persists the reel_edls row,
      // which surfaces in the Reels list via the create-poll below.
      const res = await fetch('/.netlify/functions/reel-create-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') },
        body: JSON.stringify({ manifest }),
      })
      if (res.status !== 202 && !res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || ('HTTP ' + res.status))
      }
      setPhase('')
      onCreated && onCreated(reelId)
    } catch (e) {
      setError(e.message)
      setPhase('')
    }
  }, [busy, studioId, files, theme, platform, duration, energy, hookDirection, onCreated])

  const brandVoice = app.brandVoice || ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg my-10 rounded-xl"
        style={{ background: '#14161c', border: '1px solid rgba(255,255,255,0.09)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-center gap-2">
            <Sparkles size={17} style={{ color: primary }} />
            <h2 className="text-white text-base font-semibold">New Reel</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Brand inheritance — read-only, shown */}
          <div className="rounded-lg px-3.5 py-2.5 text-xs" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="text-slate-400">Using your brand voice: </span>
            <span className="text-slate-200">{brandVoice ? `“${brandVoice}”` : `${app.studioName || 'your studio'} default`}</span>
            <div className="text-slate-500 mt-0.5">Branding is inherited from your studio — no need to re-enter it.</div>
          </div>

          {/* Theme / vibe (mirrors the content modal's "This Session's Vibe") */}
          <div>
            <label className="block text-slate-300 text-xs font-medium mb-1.5">This reel's vibe</label>
            <input
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="e.g. sunrise reformer flow, new-member welcome…"
              disabled={busy}
              className="w-full rounded-lg px-3 py-2 text-sm text-white outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
            />
          </div>

          {/* Platform */}
          <div>
            <label className="block text-slate-300 text-xs font-medium mb-1.5">Platform</label>
            <div className="grid grid-cols-3 gap-2">
              {PLATFORMS.map((p) => (
                <button
                  key={p.v}
                  onClick={() => setPlatform(p.v)}
                  disabled={busy}
                  className="rounded-lg py-2 text-xs font-medium transition-colors"
                  style={platform === p.v
                    ? { background: primary, color: '#fff', border: '1px solid ' + primary }
                    : { background: 'rgba(255,255,255,0.03)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  {p.l}
                </button>
              ))}
            </div>
          </div>

          {/* Duration + Energy */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-300 text-xs font-medium mb-1.5">Length</label>
              <div className="grid grid-cols-3 gap-2">
                {DURATIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDuration(d)}
                    disabled={busy}
                    className="rounded-lg py-2 text-xs font-medium"
                    style={duration === d
                      ? { background: primary, color: '#fff', border: '1px solid ' + primary }
                      : { background: 'rgba(255,255,255,0.03)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.1)' }}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-slate-300 text-xs font-medium mb-1.5">Energy</label>
              <div className="grid grid-cols-3 gap-2">
                {ENERGIES.map((en) => (
                  <button
                    key={en.v}
                    onClick={() => setEnergy(en.v)}
                    disabled={busy}
                    title={en.h}
                    className="rounded-lg py-2 text-xs font-medium"
                    style={energy === en.v
                      ? { background: primary, color: '#fff', border: '1px solid ' + primary }
                      : { background: 'rgba(255,255,255,0.03)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.1)' }}
                  >
                    {en.l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Hook direction (optional) */}
          <div>
            <label className="block text-slate-300 text-xs font-medium mb-1.5">Hook direction <span className="text-slate-500">(optional)</span></label>
            <input
              value={hookDirection}
              onChange={(e) => setHookDirection(e.target.value)}
              placeholder="steer the opening line — e.g. ask a question"
              disabled={busy}
              className="w-full rounded-lg px-3 py-2 text-sm text-white outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
            />
          </div>

          {/* CTA — deferred */}
          <div className="text-xs text-slate-500">Call-to-action ending — <span className="italic">coming soon</span>.</div>

          {/* Clips */}
          <div>
            <label className="block text-slate-300 text-xs font-medium mb-1.5">Clips</label>
            <label
              className="flex items-center gap-2 rounded-lg px-3 py-3 cursor-pointer text-sm text-slate-300"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.15)' }}
            >
              <UploadCloud size={16} style={{ color: primary }} />
              {files.length ? `${files.length} clip${files.length === 1 ? '' : 's'} selected` : 'Choose video clips…'}
              <input type="file" accept="video/*" multiple onChange={onPick} disabled={busy} className="hidden" />
            </label>
          </div>

          {error && (
            <div className="rounded-lg px-3.5 py-2.5 text-xs" style={{ background: 'rgba(239,68,68,0.1)', color: '#fca5a5' }}>{error}</div>
          )}
        </div>

        <div className="px-5 py-4 flex justify-end gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <button onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-sm text-slate-300 disabled:opacity-50" style={{ background: 'rgba(255,255,255,0.05)' }}>Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !studioId || !files.length}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: primary }}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {phase === 'uploading' ? 'Uploading clips…' : phase === 'submitting' ? 'Building reel…' : 'Create reel'}
          </button>
        </div>
      </div>
    </div>
  )
}

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
import { newAttemptId, emit, emitFailure } from '../lib/uploadTelemetry'
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
    // D4 — instrument at submit ENTRY, before the first condition evaluates.
    // The guard below returns before upload, before the 202, and before the Reels
    // create-poll starts, so anything hung off the poll cannot observe it. The only
    // claim that covers branches nobody has enumerated yet is "the button was
    // pressed and the path terminated here", and it has to be stamped first.
    const attemptId = newAttemptId()
    const t0 = Date.now()
    emit(attemptId, 'upload_started', {
      studio_id: studioId || null,
      clip_count: files.length,
      elapsed_ms: 0,
    })

    if (busy || !studioId || !files.length) {
      // Not a user-visible failure — a no-op guard. It is recorded anyway because
      // "she pressed the button and nothing happened" is indistinguishable from a
      // dead create path unless this row exists.
      void emitFailure(attemptId, {
        studio_id: studioId || null,
        clip_count: files.length,
        stage: 'submit_guard',
        elapsed_ms: Date.now() - t0,
        error: {
          message: 'submit returned before upload began',
          reason: busy ? 'already_busy' : !studioId ? 'no_studio_id' : 'no_files_selected',
        },
      })
      return
    }
    setError(null)
    const reelId = crypto.randomUUID()

    // 1) Upload clips to the studio's private library (RLS-scoped by studio).
    //
    // The loop is wrapped because supabase-js does NOT return every failure as
    // { error }. storage-js handleOperation ends:
    //     if (isStorageError(error)) return { data: null, error }
    //     throw error
    // so an HTTP error response (403, 409, 413 size rejection) arrives as `upErr`
    // and is handled below — but anything that is not a StorageError is RETHROWN.
    // A dropped connection mid-upload, an AbortError, or a CORS failure surfaces as
    // a bare TypeError, escapes this function entirely, and leaves the modal stuck on
    // "Uploading clips…" with no message and no telemetry: the exact silent failure
    // this feature exists to end. A mid-upload network drop is also one of the leading
    // candidates for the 08-17 attempts that never reached storage.
    setPhase('uploading')
    const sourceClips = []
    let bytesSent = 0
    let clipIndex = 0
    try {
    for (let i = 0; i < files.length; i++) {
      clipIndex = i + 1
      const clipId = crypto.randomUUID()
      const path = `${studioId}/${reelId}/${String(i + 1).padStart(2, '0')}-${sanitize(files[i].name)}`
      const { error: upErr } = await supabase.storage
        .from('reel-sources')
        .upload(path, files[i], { upsert: false, contentType: files[i].type || undefined })
      if (upErr) {
        // Customer-visible state FIRST. emitFailure serially awaits an insert, a possible
        // session refresh, and a fetch — each of which hangs on exactly the degraded
        // network that caused this failure. Awaiting it would leave her watching a
        // spinner for seconds after the outcome is already known.
        setError(`Upload failed for ${files[i].name}: ${upErr.message}`)
        setPhase('')
        // Capture the whole error object, unswallowed. `upErr.message` alone is what
        // the customer sees; the status code and body are what make it diagnosable.
        void emitFailure(attemptId, {
          studio_id: studioId,
          reel_id: reelId,
          stage: 'storage_upload',
          clip_index: i + 1,
          clip_count: files.length,
          file_name: files[i].name,
          file_size_bytes: files[i].size,
          mime_type: files[i].type || null,
          bytes_sent: bytesSent,
          elapsed_ms: Date.now() - t0,
        }, upErr)
        return
      }
      bytesSent += files[i].size
      // Progress is per-clip, not per-byte: supabase-js v2 storage exposes no
      // progress callback, and per-byte would mean replacing this call with a raw
      // XHR against the storage REST endpoint — a much larger change to a live
      // create path. Per-clip is throttled by construction.
      emit(attemptId, 'upload_progress', {
        studio_id: studioId,
        reel_id: reelId,
        clip_index: i + 1,
        clip_count: files.length,
        file_name: files[i].name,
        file_size_bytes: files[i].size,
        mime_type: files[i].type || null,
        bytes_sent: bytesSent,
        elapsed_ms: Date.now() - t0,
      })
      sourceClips.push({ clip_id: clipId, storage_path: path, uploaded_order: i + 1 })
    }
    } catch (e) {
      // Non-StorageError thrown out of supabase-js (see the note above the loop).
      // Before this branch existed the modal simply hung here forever.
      const f = files[clipIndex - 1]
      setError(
        `Upload failed for ${f ? f.name : 'your clips'}: ${e?.message || 'the connection dropped'}. ` +
        'Check your connection and try again.'
      )
      setPhase('')
      void emitFailure(attemptId, {
        studio_id: studioId,
        reel_id: reelId,
        stage: 'storage_upload_threw',
        clip_index: clipIndex,
        clip_count: files.length,
        file_name: f ? f.name : null,
        file_size_bytes: f ? f.size : null,
        mime_type: f ? (f.type || null) : null,
        bytes_sent: bytesSent,
        elapsed_ms: Date.now() - t0,
      }, e)
      return
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
      // Clips are in storage and WF1 has been dispatched. This is NOT "the reel
      // was created" — WF1 may still never persist a reel_edls row, which is the
      // orphan case. That gap is what makes this row worth having: an attempt with
      // upload_completed and no matching reel_edls row is the orphan, detectable.
      emit(attemptId, 'upload_completed', {
        studio_id: studioId,
        reel_id: reelId,
        clip_count: files.length,
        bytes_sent: bytesSent,
        elapsed_ms: Date.now() - t0,
      })
      setPhase('')
      onCreated && onCreated(reelId)
    } catch (e) {
      // Customer-visible state first, telemetry after. See the storage_upload branch.
      setError(e.message)
      setPhase('')
      void emitFailure(attemptId, {
        studio_id: studioId,
        reel_id: reelId,
        stage: 'wf1_dispatch',
        clip_count: files.length,
        bytes_sent: bytesSent,
        elapsed_ms: Date.now() - t0,
      }, e)
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

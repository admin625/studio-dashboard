/**
 * NewReelModal — B2 STEP 3: authenticated "New Reel" create flow on the Reels tab.
 *
 * In-session: upload clips to reel-sources/{studio_id}/{reel_id}/… (Option-A RLS INSERT
 * gates by studio), capture the 4 WF1-honored params, assemble the manifest, and fire WF1
 * via the `reel-create-background` function (holds x-wf1-secret; 202-then-async so WF1's slow
 * chain never times out). Brand (voice/audience) is inherited read-only from studio_accounts
 * and shown, never re-asked.
 * CTA is deferred (its own spec). Stops at manifest→WF1; approve→render stays on the card (D2).
 *
 * 2b: instrumented against FAR spec v0.3 §6. The four ad-hoc stage strings this file used to
 * invent (submit_guard, storage_upload, storage_upload_threw, wf1_dispatch) are GONE — they
 * were failure-only labels with no positive counterparts, so the stream could say what broke
 * but never what completed. Every stage below now emits in both directions.
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import {
  newAttemptId, emit, emitFailure, armAbandonBeacon,
  nameHash, pwaMode, STAGE, OK, APP_VERSION,
  MAX_CLIP_BYTES, mb, oversizeMessage,
} from '../lib/uploadTelemetry'
import { Loader2, X, Sparkles, UploadCloud } from 'lucide-react'

const SURFACE = 'NewReelModal'
const BUCKET = 'reel-sources'

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

// Local twin of ReelUpload's decoder. Duplicated deliberately for a tight diff; the two
// should converge into uploadTelemetry.js, which both files already import. Recorded as a
// follow-on rather than done silently here.
function decodeJwtClaim(token, key) {
  try {
    const part = token.split('.')[1]
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)[key] ?? null
  } catch {
    return null
  }
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

  // The attempt id is minted at FIRST FILE SELECT, not at submit. An attempt abandoned
  // between picking clips and pressing the button is still an attempt, and it was the one
  // class nothing could see.
  const attemptRef = useRef(null)
  // Live snapshot for the abandonment beacon, which fires during unload and cannot read
  // React state through a stale closure.
  const progressRef = useRef({ reel_id: null, clip_index: null, clip_count: 0, storage_path: null, t0: null })
  const disarmRef = useRef(null)

  useEffect(() => () => { if (disarmRef.current) disarmRef.current() }, [])

  const busy = phase !== ''

  const onPick = useCallback((e) => {
    const picked = Array.from(e.target.files || [])
    setFiles(picked)
    setError(null)
    if (!picked.length) return

    const attemptId = newAttemptId()
    attemptRef.current = attemptId
    progressRef.current = { reel_id: null, clip_index: null, clip_count: picked.length, storage_path: null, t0: Date.now() }

    // Client-side size gate, BEFORE transmit_started. Measured 2026-09-02: a 482 MB clip
    // transmitted for 64.4 SECONDS on mobile before the server returned 400. The bucket limit
    // stays authoritative server-side — this only stops the customer paying for the upload
    // twice over in time and cellular data to learn something we already know.
    const over = picked.filter((f) => f.size > MAX_CLIP_BYTES)
    if (over.length) {
      setFiles([])
      setError(oversizeMessage(over))
      over.forEach((f) => {
        void emitFailure(attemptId, STAGE.FILE_SELECTED, {
          studio_id: studioId || null,
          clip_index: picked.indexOf(f) + 1,
          clip_count: picked.length,
          file_size_bytes: f.size,
          mime_type: f.type || null,
          storage_bucket: BUCKET,
          error_code: 'oversize',
          error_message: `clip is ${mb(f.size)} MB, limit is ${mb(MAX_CLIP_BYTES)} MB`,
          payload: {
            surface: SURFACE,
            name_hash: nameHash(f.name),
            limit_bytes: MAX_CLIP_BYTES,
            over_by_bytes: f.size - MAX_CLIP_BYTES,
            blocked_client_side: true,
          },
        })
      })
      return
    }

    // One row per selected clip: the size distribution at selection is what makes an
    // oversize rejection later legible, and it is captured before any transmission.
    picked.forEach((f, i) => {
      void emit(attemptId, STAGE.FILE_SELECTED, OK, {
        studio_id: studioId || null,
        clip_index: i + 1,
        clip_count: picked.length,
        file_size_bytes: f.size,
        mime_type: f.type || null,
        storage_bucket: BUCKET,
        payload: {
          surface: SURFACE,
          name_hash: nameHash(f.name),
          mime: f.type || null,
          ua: typeof navigator !== 'undefined' ? navigator.userAgent : null,
          app_version: APP_VERSION,
          pwa_mode: pwaMode(),
        },
      })
    })
  }, [studioId])

  const submit = useCallback(async () => {
    const attemptId = attemptRef.current || newAttemptId()
    attemptRef.current = attemptId
    const t0 = progressRef.current.t0 || Date.now()

    // Precondition guard. The old code labelled every rejection here 'submit_guard'; the
    // reasons are not one stage. Missing studio context is a session problem, missing files
    // is a selection problem, and they are diagnosed in different places.
    if (busy || !studioId || !files.length) {
      const reason = busy ? 'already_busy' : !studioId ? 'no_studio_id' : 'no_files_selected'
      const stage = reason === 'no_files_selected' ? STAGE.FILE_SELECTED : STAGE.SESSION_CHECKED
      void emitFailure(attemptId, stage, {
        studio_id: studioId || null,
        clip_count: files.length,
        elapsed_ms: Date.now() - t0,
        error_code: reason,
        error_message: 'submit returned before upload began',
        payload: { surface: SURFACE, reason },
      })
      return
    }
    setError(null)
    const reelId = crypto.randomUUID()
    progressRef.current = { ...progressRef.current, reel_id: reelId, clip_count: files.length, t0 }

    // Abandonment: armed for the whole transmission window, disarmed at every terminal exit.
    // pagehide + sendBeacon is the only combination that survives a backgrounded mobile tab.
    disarmRef.current = armAbandonBeacon(attemptId, () => ({
      studio_id: studioId,
      reel_id: progressRef.current.reel_id,
      clip_index: progressRef.current.clip_index,
      clip_count: progressRef.current.clip_count,
      storage_bucket: BUCKET,
      storage_path: progressRef.current.storage_path,
      elapsed_ms: Date.now() - t0,
      error_code: 'pagehide',
      error_message: 'page hidden with an upload in flight',
      payload: { surface: SURFACE, phase: 'uploading' },
    }))
    const disarm = () => { if (disarmRef.current) { disarmRef.current(); disarmRef.current = null } }

    // session_checked fires BEFORE the upload loop (WO-4b). It used to sit at the manifest
    // stage, AFTER the loop — so on Katie's 2026-09-03 attempt the upload failed at 559.7s and
    // submit() returned before it ever ran. The one signal that proves whether Supabase Auth
    // actually invokes custom_access_token_hook was therefore unobtainable from precisely the
    // attempts most worth diagnosing: the failed ones. A probe that only fires on success
    // cannot diagnose failure.
    let token = null
    try {
      const { data } = await supabase.auth.getSession()
      token = data?.session?.access_token || null
      const claimed = token ? decodeJwtClaim(token, 'fca_studio_id') : null
      if (!token) {
        void emitFailure(attemptId, STAGE.SESSION_CHECKED, {
          studio_id: studioId, reel_id: reelId,
          elapsed_ms: Date.now() - t0,
          error_code: 'no_session',
          error_message: 'getSession resolved with no session',
          payload: { surface: SURFACE, studio_id_source: 'none' },
        })
      } else {
        void emit(attemptId, STAGE.SESSION_CHECKED, OK, {
          studio_id: studioId, reel_id: reelId,
          elapsed_ms: Date.now() - t0,
          payload: {
            surface: SURFACE,
            // THE AUTH-HOOK ENABLEMENT PROOF. fca_studio_id_claim means Supabase Auth really
            // invokes the hook. appcontext_resolved means it does not, and every studio is
            // silently on the slow DB path. Mac's own account cannot answer this — the hook
            // returns early for admin@fiorsaoirse.com by design — so only a non-admin owner's
            // session settles it.
            studio_id_source: claimed ? 'fca_studio_id_claim' : 'appcontext_resolved',
            claim_present: !!claimed,
          },
        })
      }
    } catch (se) {
      void emitFailure(attemptId, STAGE.SESSION_CHECKED, {
        studio_id: studioId, reel_id: reelId,
        elapsed_ms: Date.now() - t0,
        error_code: 'getsession_threw',
        payload: { surface: SURFACE },
      }, se)
    }

    setPhase('uploading')
    const sourceClips = []
    let bytesSent = 0
    let clipIndex = 0
    try {
    for (let i = 0; i < files.length; i++) {
      clipIndex = i + 1
      const clipId = crypto.randomUUID()
      const path = `${studioId}/${reelId}/${String(i + 1).padStart(2, '0')}-${sanitize(files[i].name)}`
      progressRef.current = { ...progressRef.current, clip_index: clipIndex, storage_path: path }

      const clipT0 = Date.now()
      void emit(attemptId, STAGE.TRANSMIT_STARTED, OK, {
        studio_id: studioId, reel_id: reelId,
        clip_index: clipIndex, clip_count: files.length,
        file_size_bytes: files[i].size, mime_type: files[i].type || null,
        storage_bucket: BUCKET, storage_path: path,
        elapsed_ms: Date.now() - t0,
        payload: { surface: SURFACE, name_hash: nameHash(files[i].name) },
      })

      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, files[i], { upsert: false, contentType: files[i].type || undefined })
      if (upErr) {
        // Customer-visible state FIRST. emitFailure serially awaits an insert, a possible
        // session refresh, and a fetch — each of which hangs on exactly the degraded
        // network that caused this failure.
        setError(`Upload failed for ${files[i].name}: ${upErr.message}`)
        setPhase('')
        disarm()
        void emitFailure(attemptId, STAGE.TRANSMIT_COMPLETED, {
          studio_id: studioId, reel_id: reelId,
          clip_index: clipIndex, clip_count: files.length,
          file_size_bytes: files[i].size, mime_type: files[i].type || null,
          storage_bucket: BUCKET, storage_path: path,
          elapsed_ms: Date.now() - clipT0,
          payload: { surface: SURFACE, attempt_elapsed_ms: Date.now() - t0 },
        }, upErr)
        return
      }
      bytesSent += files[i].size

      // Per-clip, not per-byte: supabase-js v2 storage exposes no progress callback, and
      // per-byte would mean replacing this call with a raw XHR against the storage REST
      // endpoint — a much larger change to a live create path.
      void emit(attemptId, STAGE.TRANSMIT_COMPLETED, OK, {
        studio_id: studioId, reel_id: reelId,
        clip_index: clipIndex, clip_count: files.length,
        file_size_bytes: files[i].size, mime_type: files[i].type || null,
        storage_bucket: BUCKET, storage_path: path,
        elapsed_ms: Date.now() - clipT0,
        payload: { surface: SURFACE, attempt_elapsed_ms: Date.now() - t0, bytes_sent_total: bytesSent },
      })

      sourceClips.push({
        clip_id: clipId,
        storage_path: path,
        uploaded_order: i + 1,
        client_bytes: files[i].size,
      })
    }
    } catch (e) {
      // Non-StorageError thrown out of supabase-js. storage-js rethrows anything that is not
      // a StorageError, so a dropped connection, an AbortError or a CORS failure lands here
      // as a bare TypeError. Before this branch existed the modal simply hung forever.
      const f = files[clipIndex - 1]
      setError(
        `Upload failed for ${f ? f.name : 'your clips'}: ${e?.message || 'the connection dropped'}. ` +
        'Check your connection and try again.'
      )
      setPhase('')
      disarm()
      void emitFailure(attemptId, STAGE.TRANSMIT_COMPLETED, {
        studio_id: studioId, reel_id: reelId,
        clip_index: clipIndex, clip_count: files.length,
        file_size_bytes: f ? f.size : null,
        mime_type: f ? (f.type || null) : null,
        storage_bucket: BUCKET, storage_path: progressRef.current.storage_path,
        elapsed_ms: Date.now() - t0,
        payload: { surface: SURFACE, threw: true },
      }, e)
      return
    }

    // 2) Assemble manifest + fire WF1 (server-side, x-wf1-secret held there).
    setPhase('submitting')
    const manifest = {
      manifest_version: '1.0',
      correlation_id: attemptId,
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
      // Background function: WF1 is slow (sign->probe->Opus->persist), so firing it must not
      // block on a sync timeout. It returns 202 immediately; WF1 persists the reel_edls row,
      // which surfaces in the Reels list via the create-poll below.
      const res = await fetch('/.netlify/functions/reel-create-background', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-correlation-id': attemptId,
          Authorization: 'Bearer ' + (token || ''),
        },
        body: JSON.stringify({ manifest }),
      })

      // 202 is the background function's acknowledgement, NOT a WF1 result. The server-side
      // wf1_triggered row is the only thing that knows whether WF1 actually accepted.
      void emit(attemptId, STAGE.CREATE_REQUEST_SENT, res.status === 202 || res.ok ? OK : 'fail', {
        studio_id: studioId, reel_id: reelId,
        clip_count: files.length,
        http_status: res.status,
        elapsed_ms: Date.now() - t0,
        payload: { surface: SURFACE, acknowledged_202: res.status === 202 },
      })

      if (res.status !== 202 && !res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || ('HTTP ' + res.status))
      }
      disarm()
      setPhase('')
      onCreated && onCreated(reelId)
    } catch (e) {
      // Customer-visible state first, telemetry after.
      setError(e.message)
      setPhase('')
      disarm()
      void emitFailure(attemptId, STAGE.CREATE_REQUEST_SENT, {
        studio_id: studioId, reel_id: reelId,
        clip_count: files.length,
        elapsed_ms: Date.now() - t0,
        payload: { surface: SURFACE },
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

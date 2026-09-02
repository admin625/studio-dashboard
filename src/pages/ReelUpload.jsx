import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import {
  newAttemptId, emit, emitFailure, armAbandonBeacon,
  nameHash, pwaMode, STAGE, OK, APP_VERSION,
} from '../lib/uploadTelemetry'

/**
 * ReelUpload — B2 STEP 2: authenticated studio upload surface for the Reel Editor.
 *
 * Uploads raw clips to the private `reel-sources` bucket under `{studio_id}/{reel_id}/…`.
 * Access is gated server-side by the Option-A RLS INSERT policy
 * (`(storage.foldername(name))[1] = any(get_my_studio_ids())`), so a session can only
 * write under its own studio's folder. Studio context is read client-side from the
 * `fca_studio_id` JWT claim (the app-layer use of the custom access-token hook), with a
 * fallback to the DB-resolved studio id in AppContext (e.g. admin sessions, which the
 * hook intentionally does not claim).
 *
 * Unlinked/private-beta route (`/reels/upload`). It does NOT fire WF1 — manifest assembly
 * and the trigger live in NewReelModal. That asymmetry is why this surface needs its own
 * telemetry: uploads land here that never become reels, and until 2b nothing recorded them.
 *
 * ⚠️ KNOWN GAP, DELIBERATELY NOT FIXED HERE (out of scope):
 * the session effect below is `getSession().then(({ data }) => …)` with no rejection
 * handler. If that promise REJECTS, onFulfilled never runs, the rejection escapes as an
 * unhandled promise rejection, and the page renders "Loading…" forever. There is no
 * reachable point inside the existing control flow from which to emit session_checked=fail
 * for that case — emitting would require adding the `.catch` that constitutes the fix. So
 * the rejection branch is STRUCTURALLY UNINSTRUMENTABLE as written, and is recorded as an
 * uncovered window rather than papered over. The null-session branch IS reachable and is
 * instrumented.
 */

const FOREIGN_TEST_STUDIO = '00000000-0000-0000-0000-000000000000'
const SURFACE = 'ReelUpload'
const BUCKET = 'reel-sources'

function decodeJwtClaim(token, key) {
  try {
    const part = token.split('.')[1]
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)[key] ?? null
  } catch {
    return null
  }
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

export default function ReelUpload() {
  const app = useApp()
  const navigate = useNavigate()
  const [sessionOk, setSessionOk] = useState(false)
  const [claimStudioId, setClaimStudioId] = useState(null)
  const [claimChecked, setClaimChecked] = useState(false)
  const [reelId, setReelId] = useState('')
  const [rows, setRows] = useState([]) // { name, status: 'pending'|'uploading'|'done'|'error', path, error }
  const [busy, setBusy] = useState(false)
  const [rlsTest, setRlsTest] = useState(null) // { own, cross }

  const attemptRef = useRef(null)
  const progressRef = useRef({ clip_index: null, clip_count: 0, storage_path: null, t0: null })
  const disarmRef = useRef(null)
  const sessionEmittedRef = useRef(false)

  useEffect(() => () => { if (disarmRef.current) disarmRef.current() }, [])

  // Authoritative session guard: getSession() reflects the actual stored session.
  // No active session => redirect to login (the surface must not render without one).
  // This is stricter than ProtectedRoute's cached user check, which can pass on a
  // stale/persisted user object.
  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      const session = data?.session
      if (!session) {
        // Reachable, and the common failure. The rejection branch above it is not.
        sessionEmittedRef.current = true
        void emitFailure(newAttemptId(), STAGE.SESSION_CHECKED, {
          // Attribution: the claim is absent by definition here (there is no session), so
          // the DB-resolved id from AppContext is the only studio context available.
          studio_id: app.resolvedStudioId || null,
          error_code: 'no_session',
          error_message: 'getSession resolved with no session on /reels/upload',
          payload: {
            surface: SURFACE, app_version: APP_VERSION, pwa_mode: pwaMode(),
            studio_id_source: app.resolvedStudioId ? 'appcontext_resolved' : 'none',
          },
        })
        navigate('/login', { replace: true })
        return
      }
      setClaimStudioId(decodeJwtClaim(session.access_token, 'fca_studio_id'))
      setClaimChecked(true)
      setSessionOk(true)
    })
    setReelId(crypto.randomUUID())
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate])

  // Prefer the token claim (app-layer hook use); fall back to the DB-resolved studio id.
  const studioId = claimStudioId || app.resolvedStudioId || null
  const studioIdSource = claimStudioId ? 'fca_studio_id JWT claim' : (app.resolvedStudioId ? 'AppContext (DB-resolved)' : 'none')

  // session_checked=ok is emitted from its OWN effect, not from the getSession callback.
  //
  // Why: on 2026-09-02 at 17:11:28Z this surface wrote a session_checked row with
  // studio_id NULL and studio_id_source "claim_absent" — while the page itself was
  // displaying the studio correctly. The callback read only the JWT claim, but this
  // session had no `fca_studio_id` claim and resolved through AppContext instead. The row
  // landed (the INSERT policy permits a NULL studio_id) and was invisible to every
  // per-studio query, which is the worst of both outcomes: recorded, and unfindable.
  //
  // AppContext resolution is asynchronous and frequently lands AFTER getSession returns, so
  // reading it inside that callback would still race. This effect re-runs as studio context
  // arrives and the ref makes it fire exactly once.
  useEffect(() => {
    if (!sessionOk || sessionEmittedRef.current) return
    if (!claimStudioId && !app.resolvedStudioId && !app.authReady) return // still resolving
    sessionEmittedRef.current = true
    void emit(newAttemptId(), STAGE.SESSION_CHECKED, OK, {
      studio_id: claimStudioId || app.resolvedStudioId || null,
      payload: {
        surface: SURFACE,
        app_version: APP_VERSION,
        pwa_mode: pwaMode(),
        studio_id_source: claimStudioId
          ? 'fca_studio_id_claim'
          : (app.resolvedStudioId ? 'appcontext_resolved' : 'unresolved'),
      },
    })
  }, [sessionOk, claimStudioId, app.resolvedStudioId, app.authReady])

  const onPick = useCallback((e) => {
    const picked = Array.from(e.target.files || [])
    setRows(picked.map(f => ({ file: f, name: f.name, status: 'pending', path: null, error: null })))
    if (!picked.length) return

    const attemptId = newAttemptId()
    attemptRef.current = attemptId
    progressRef.current = { clip_index: null, clip_count: picked.length, storage_path: null, t0: Date.now() }

    picked.forEach((f, i) => {
      void emit(attemptId, STAGE.FILE_SELECTED, OK, {
        studio_id: studioId || null,
        reel_id: reelId || null,
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
  }, [studioId, reelId])

  const upload = useCallback(async () => {
    if (!studioId || !rows.length || busy) return
    setBusy(true)
    const attemptId = attemptRef.current || newAttemptId()
    attemptRef.current = attemptId
    const rid = reelId || crypto.randomUUID()
    const t0 = progressRef.current.t0 || Date.now()

    disarmRef.current = armAbandonBeacon(attemptId, () => ({
      studio_id: studioId,
      reel_id: rid,
      clip_index: progressRef.current.clip_index,
      clip_count: progressRef.current.clip_count,
      storage_bucket: BUCKET,
      storage_path: progressRef.current.storage_path,
      elapsed_ms: Date.now() - t0,
      error_code: 'pagehide',
      error_message: 'page hidden with an upload in flight',
      payload: { surface: SURFACE },
    }))

    for (let i = 0; i < rows.length; i++) {
      setRows(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'uploading' } : r))
      const path = `${studioId}/${rid}/${String(i + 1).padStart(2, '0')}-${sanitize(rows[i].name)}`
      progressRef.current = { ...progressRef.current, clip_index: i + 1, storage_path: path }
      const clipT0 = Date.now()

      void emit(attemptId, STAGE.TRANSMIT_STARTED, OK, {
        studio_id: studioId, reel_id: rid,
        clip_index: i + 1, clip_count: rows.length,
        file_size_bytes: rows[i].file?.size ?? null,
        mime_type: rows[i].file?.type || null,
        storage_bucket: BUCKET, storage_path: path,
        elapsed_ms: Date.now() - t0,
        payload: { surface: SURFACE, name_hash: nameHash(rows[i].name) },
      })

      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, rows[i].file, { upsert: false, contentType: rows[i].file.type || undefined })

      if (error) {
        void emitFailure(attemptId, STAGE.TRANSMIT_COMPLETED, {
          studio_id: studioId, reel_id: rid,
          clip_index: i + 1, clip_count: rows.length,
          file_size_bytes: rows[i].file?.size ?? null,
          mime_type: rows[i].file?.type || null,
          storage_bucket: BUCKET, storage_path: path,
          elapsed_ms: Date.now() - clipT0,
          payload: { surface: SURFACE, attempt_elapsed_ms: Date.now() - t0 },
        }, error)
      } else {
        void emit(attemptId, STAGE.TRANSMIT_COMPLETED, OK, {
          studio_id: studioId, reel_id: rid,
          clip_index: i + 1, clip_count: rows.length,
          file_size_bytes: rows[i].file?.size ?? null,
          mime_type: rows[i].file?.type || null,
          storage_bucket: BUCKET, storage_path: path,
          elapsed_ms: Date.now() - clipT0,
          payload: { surface: SURFACE, attempt_elapsed_ms: Date.now() - t0 },
        })
      }

      setRows(prev => prev.map((r, idx) => idx === i
        ? { ...r, status: error ? 'error' : 'done', path: error ? null : path, error: error ? error.message : null }
        : r))
    }
    if (disarmRef.current) { disarmRef.current(); disarmRef.current = null }
    setBusy(false)
  }, [studioId, rows, reelId, busy])

  // Demonstrate the RLS boundary in-browser: own path (a throwaway probe) allowed,
  // foreign studio path blocked. Uses tiny text blobs, not real clips.
  const runRlsTest = useCallback(async () => {
    if (!studioId) return
    setRlsTest({ own: 'running', cross: 'running' })
    const probe = new Blob(['rls-probe'], { type: 'text/plain' })
    // Stable probe path (upsert) so repeated tests overwrite one object rather than littering.
    const ownPath = `${studioId}/_rls_probe/probe.txt`
    const crossPath = `${FOREIGN_TEST_STUDIO}/_rls_probe/probe.txt`
    const own = await supabase.storage.from(BUCKET).upload(ownPath, probe, { upsert: true })
    const cross = await supabase.storage.from(BUCKET).upload(crossPath, probe, { upsert: true })
    setRlsTest({
      own: own.error ? `unexpected: ${own.error.message}` : 'ALLOWED (own studio) ✓',
      cross: cross.error ? 'BLOCKED (cross studio) ✓' : 'UNEXPECTED: cross-studio write succeeded ✗',
    })
  }, [studioId])

  const donePaths = rows.filter(r => r.status === 'done').map(r => r.path)
  const brand = app.brandColorPrimary || '#667eea'

  // Render nothing but a loader until the session is confirmed. If there is no
  // session the effect above redirects to /login, so the uploader never renders unauthenticated.
  if (!app.authReady || !sessionOk) return <div style={{ padding: 24 }}>Loading…</div>
  if (!app.isBeta) {
    return (
      <div style={{ maxWidth: 640, margin: '48px auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h2>Reel upload</h2>
        <p style={{ color: '#666' }}>The self-serve reel editor is in private beta. Contact Fiorsaoirse to join.</p>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 720, margin: '32px auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginBottom: 4 }}>Upload reel clips</h2>
      <p style={{ color: '#666', marginTop: 0, fontSize: 14 }}>Private beta. Clips upload to your studio's private library.</p>

      <div style={{ background: '#f6f7f9', borderRadius: 8, padding: '10px 14px', fontSize: 13, margin: '12px 0' }}>
        <div><strong>Studio:</strong> {studioId || '— (no studio context)'} </div>
        <div><strong>Source:</strong> {claimChecked ? studioIdSource : 'checking session…'}</div>
        <div><strong>Reel id:</strong> {reelId}</div>
      </div>

      {!studioId && claimChecked && (
        <p style={{ color: '#b00' }}>No studio context on this session — upload unavailable.</p>
      )}

      <input type="file" accept="video/*" multiple onChange={onPick} disabled={busy || !studioId} />
      <div style={{ marginTop: 12 }}>
        <button
          onClick={upload}
          disabled={busy || !studioId || !rows.length}
          style={{ background: brand, color: '#fff', border: 0, borderRadius: 6, padding: '8px 16px', cursor: 'pointer', opacity: (busy || !rows.length) ? 0.6 : 1 }}
        >
          {busy ? 'Uploading…' : `Upload ${rows.length || ''} clip${rows.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {rows.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 16 }}>
          {rows.map((r, i) => (
            <li key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee', fontSize: 13 }}>
              <span>{r.name}</span>
              <span style={{ color: r.status === 'error' ? '#b00' : r.status === 'done' ? '#0a7' : '#888' }}>
                {r.status === 'error' ? `error: ${r.error}` : r.status}
              </span>
            </li>
          ))}
        </ul>
      )}

      {donePaths.length > 0 && (
        <div style={{ marginTop: 16, fontSize: 12, color: '#555' }}>
          <strong>Uploaded storage paths</strong> (for the STEP 3 manifest):
          <pre style={{ background: '#f6f7f9', borderRadius: 6, padding: 10, overflowX: 'auto' }}>{donePaths.join('\n')}</pre>
        </div>
      )}

      <hr style={{ margin: '24px 0', border: 0, borderTop: '1px solid #eee' }} />
      <div>
        <button
          onClick={runRlsTest}
          disabled={!studioId}
          style={{ background: '#fff', color: brand, border: `1px solid ${brand}`, borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}
        >
          Verify studio isolation (RLS self-test)
        </button>
        {rlsTest && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <div>Own-studio write: {rlsTest.own}</div>
            <div>Cross-studio write: {rlsTest.cross}</div>
          </div>
        )}
      </div>
    </div>
  )
}

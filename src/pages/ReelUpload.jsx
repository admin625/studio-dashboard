import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'

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
 * Unlinked/private-beta route (`/reels/upload`). STEP 3 adds parameter capture + manifest
 * assembly + the WF1 trigger; this step is the upload surface only.
 */

const FOREIGN_TEST_STUDIO = '00000000-0000-0000-0000-000000000000'

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
  const [claimStudioId, setClaimStudioId] = useState(null)
  const [claimChecked, setClaimChecked] = useState(false)
  const [reelId, setReelId] = useState('')
  const [rows, setRows] = useState([]) // { name, status: 'pending'|'uploading'|'done'|'error', path, error }
  const [busy, setBusy] = useState(false)
  const [rlsTest, setRlsTest] = useState(null) // { own, cross }

  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      const token = data?.session?.access_token
      setClaimStudioId(token ? decodeJwtClaim(token, 'fca_studio_id') : null)
      setClaimChecked(true)
    })
    setReelId(crypto.randomUUID())
    return () => { active = false }
  }, [])

  // Prefer the token claim (app-layer hook use); fall back to the DB-resolved studio id.
  const studioId = claimStudioId || app.resolvedStudioId || null
  const studioIdSource = claimStudioId ? 'fca_studio_id JWT claim' : (app.resolvedStudioId ? 'AppContext (DB-resolved)' : 'none')

  const onPick = useCallback((e) => {
    const picked = Array.from(e.target.files || [])
    setRows(picked.map(f => ({ file: f, name: f.name, status: 'pending', path: null, error: null })))
  }, [])

  const upload = useCallback(async () => {
    if (!studioId || !rows.length || busy) return
    setBusy(true)
    const rid = reelId || crypto.randomUUID()
    for (let i = 0; i < rows.length; i++) {
      setRows(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'uploading' } : r))
      const path = `${studioId}/${rid}/${String(i + 1).padStart(2, '0')}-${sanitize(rows[i].name)}`
      const { error } = await supabase.storage
        .from('reel-sources')
        .upload(path, rows[i].file, { upsert: false, contentType: rows[i].file.type || undefined })
      setRows(prev => prev.map((r, idx) => idx === i
        ? { ...r, status: error ? 'error' : 'done', path: error ? null : path, error: error ? error.message : null }
        : r))
    }
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
    const own = await supabase.storage.from('reel-sources').upload(ownPath, probe, { upsert: true })
    const cross = await supabase.storage.from('reel-sources').upload(crossPath, probe, { upsert: true })
    setRlsTest({
      own: own.error ? `unexpected: ${own.error.message}` : 'ALLOWED (own studio) ✓',
      cross: cross.error ? 'BLOCKED (cross studio) ✓' : 'UNEXPECTED: cross-studio write succeeded ✗',
    })
  }, [studioId])

  const donePaths = rows.filter(r => r.status === 'done').map(r => r.path)
  const brand = app.brandColorPrimary || '#667eea'

  if (!app.authReady) return <div style={{ padding: 24 }}>Loading…</div>
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

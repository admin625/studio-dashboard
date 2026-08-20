/**
 * uploadTelemetry — client-side lifecycle events for the reel upload path.
 *
 * Why this exists: the create path fails silently by construction. Reels.jsx:84-91
 * polls for a reel_edls row and at 90s calls setAwaitingReelId(null) with no error,
 * toast, or card. Three studios' worth of uploads reached storage with no matching
 * row and nobody found out for a month; a further class of failure never reaches
 * storage at all and leaves no trace anywhere. Nothing in the system observed either.
 *
 * This writes to public.upload_events. It is NOT generation_events — that table is
 * LLM-call shaped (model/tokens/call_role) and is service_role-written by n8n. This
 * one is written by the browser as `authenticated`, the opposite trust model.
 *
 * THE EMITTER MUST NEVER BREAK THE UPLOAD. Every entry point swallows its own
 * transport errors. It must also never fail *silently* — a vanished emit is the
 * exact defect being fixed one layer down — so every drop path logs.
 *
 * Two timestamps, deliberately:
 *   occurred_at — stamped HERE, when the thing happened.
 *   created_at  — server default now(), when the row ARRIVED.
 * A queued event replayed minutes later arrives late by design. Collapsed into one
 * column, that replay would be indistinguishable from a fresh event and the stream
 * becomes unreadable for the exact question it exists to answer.
 *
 * KNOWN GAP — both channels share one JWT. The upload_events INSERT policy requires
 * auth.uid() IS NOT NULL, and telemetry-alert 401s on a token /auth/v1/user rejects.
 * So a failure *caused by* an expired session records nowhere. We attempt a refresh
 * before giving up, but a genuinely dead session is unrecordable by this module. That
 * class needs an unauthenticated ingest path and is deliberately out of scope here.
 */
import { supabase } from './supabase'

const QUEUE_KEY = 'fca_upload_events_queue'
const QUEUE_MAX = 50
const RAW_MAX_CHARS = 4000

/** Delivery outcomes. Tri-state on purpose: 'queued' is not 'dropped'. */
export const DELIVERED = 'delivered'
export const QUEUED = 'queued'
export const DROPPED = 'dropped'

/** Stamped at submit ENTRY, before any condition evaluates. See D4 in NewReelModal. */
export function newAttemptId() {
  return crypto.randomUUID()
}

/**
 * Flatten an unknown throwable without swallowing it.
 *
 * Supabase StorageApiError carries `status`/`statusCode` and a `message`; a network
 * failure is a bare TypeError; a thrown string is neither. Capture all of it, and keep
 * a `raw` copy so a shape we did not anticipate is still legible later.
 *
 * `raw` is length-capped: 50 queued rows each carrying an unbounded blob can exceed
 * the ~5MB origin quota, after which every queue write silently no-ops.
 */
function serializeError(err) {
  if (err == null) return { message: 'unknown error (null/undefined thrown)' }
  if (typeof err !== 'object') return { message: String(err), name: typeof err }

  let raw = null
  try {
    // Own enumerable props only. Error's message/name are non-enumerable, so they are
    // captured explicitly below rather than relied on here.
    const s = JSON.stringify(err, Object.getOwnPropertyNames(err))
    raw = s && s.length > RAW_MAX_CHARS
      ? { truncated: true, original_length: s.length, head: s.slice(0, RAW_MAX_CHARS) }
      : JSON.parse(s)
  } catch {
    raw = { unserializable: true }
  }

  return {
    message: err.message ?? String(err),
    name: err.name ?? null,
    status: err.status ?? null,
    statusCode: err.statusCode ?? null,
    code: err.code ?? null,
    raw,
  }
}

/**
 * Is this failure permanent for this row?
 *
 * A schema/validation rejection (PGRST*, 4xx that is not auth) will fail identically
 * forever — re-queueing it poisons the queue and traps every later event behind it.
 * Auth failures and network failures are transient and worth retrying.
 */
function isPermanentRejection(error) {
  if (!error) return false
  const status = Number(error.status ?? error.statusCode ?? 0)
  if (status === 401 || status === 403 || status === 429) return false
  if (typeof error.code === 'string' && error.code.startsWith('PGRST')) return true
  return status >= 400 && status < 500
}

function readQueue() {
  try {
    const v = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function writeQueue(rows) {
  try {
    // Keep the NEWEST QUEUE_MAX. Callers must order oldest-first so this evicts the
    // genuinely oldest — see flushQueue, which prepends the replayed batch.
    localStorage.setItem(QUEUE_KEY, JSON.stringify(rows.slice(-QUEUE_MAX)))
    return true
  } catch (e) {
    // Loud. This is a drop, and a silent drop is the defect this module exists to fix.
    console.warn('[uploadTelemetry] queue write failed, events dropped:', e?.name, e?.message)
    return false
  }
}

/**
 * Replay anything a previous emit could not deliver, one row at a time.
 *
 * Row-by-row, not a batch: PostgREST fails an entire multi-row insert if any single
 * row is invalid, so one bad row would block every good one behind it permanently.
 *
 * The queue is cleared only for rows confirmed written. Clearing up front loses the
 * whole buffer if the tab closes mid-flight.
 */
async function flushQueue() {
  const queued = readQueue()
  if (!queued.length) return

  const unsent = []
  for (let i = 0; i < queued.length; i++) {
    const row = queued[i]
    try {
      const { error } = await supabase.from('upload_events').insert(row)
      if (!error) continue
      if (isPermanentRejection(error)) {
        console.warn('[uploadTelemetry] dropping permanently-rejected queued event:',
          error.code || error.status, error.message, row.event_type)
        continue // dropped on purpose; re-queueing would poison the queue
      }
      unsent.push(row)
    } catch (e) {
      // Transport died — keep this row and everything after it, in order.
      console.warn('[uploadTelemetry] replay transport failure, retaining queue:', e?.message)
      unsent.push(...queued.slice(i))
      break
    }
  }
  // Replayed rows are OLDER than anything queued since, so they go at the head and
  // the QUEUE_MAX slice evicts them first.
  writeQueue(unsent.concat(readQueue().filter((r) => !queued.includes(r))))
}

/**
 * Write one event. Returns DELIVERED | QUEUED | DROPPED. Never throws.
 */
export async function emit(attemptId, eventType, fields = {}) {
  const row = {
    attempt_id: attemptId,
    event_type: eventType,
    // When it HAPPENED. created_at is left to the server default, which records when
    // it ARRIVED. Never set created_at from the client.
    occurred_at: new Date().toISOString(),
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    source: 'client',
    ...fields,
  }

  try {
    await flushQueue()
    const { error } = await supabase.from('upload_events').insert(row)
    if (!error) return DELIVERED

    if (isPermanentRejection(error)) {
      console.error('[uploadTelemetry] event permanently rejected, DROPPED:',
        error.code || error.status, error.message, row.event_type)
      return DROPPED
    }
    console.warn('[uploadTelemetry] emit failed, queued for replay:', error.message, row.event_type)
    return writeQueue(readQueue().concat([row])) ? QUEUED : DROPPED
  } catch (e) {
    console.warn('[uploadTelemetry] emit threw, queued for replay:', e?.message, row.event_type)
    return writeQueue(readQueue().concat([row])) ? QUEUED : DROPPED
  }
}

/**
 * Failure event + Slack page, in that order.
 *
 * The row is the durable record and is written first; Slack is a notification and is
 * allowed to fail without costing us the row. Routed to a Netlify function that holds
 * SLACK_WEBHOOK_URL server-side — the webhook must never enter the bundle. Not
 * far_alerts: that table has RLS enabled with zero policies and has never accepted a
 * write. An unproven path does not get a new consumer as its first test.
 *
 * Callers should NOT await this on a user-visible path — set the error state first.
 */
export async function emitFailure(attemptId, fields = {}, err = null) {
  const error = err ? serializeError(err) : (fields.error ?? null)

  let outcome = await emit(attemptId, 'upload_failed', { ...fields, error })

  // If the session is what broke, one refresh is worth trying before we accept that
  // the failure is unrecordable.
  if (outcome !== DELIVERED) {
    try {
      const { error: refreshErr } = await supabase.auth.refreshSession()
      if (!refreshErr) outcome = await emit(attemptId, 'upload_failed', { ...fields, error })
    } catch { /* refresh unavailable; keep the original outcome */ }
  }

  try {
    const { data } = await supabase.auth.getSession()
    await fetch('/.netlify/functions/telemetry-alert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (data?.session?.access_token || ''),
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        studio_id: fields.studio_id ?? null,
        reel_id: fields.reel_id ?? null,
        stage: fields.stage ?? null,
        file_name: fields.file_name ?? null,
        file_size_bytes: fields.file_size_bytes ?? null,
        mime_type: fields.mime_type ?? null,
        elapsed_ms: fields.elapsed_ms ?? null,
        // Tri-state. 'queued' still lands; only 'dropped' means the record is gone.
        row_outcome: outcome,
        error_message: error?.message ?? null,
        error_status: error?.status ?? error?.statusCode ?? null,
      }),
    })
  } catch (e) {
    console.warn('[uploadTelemetry] Slack alert failed (row outcome: ' + outcome + '):', e?.message)
  }

  return outcome
}

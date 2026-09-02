/**
 * uploadTelemetry — client-side lifecycle events for the reel upload path.
 *
 * Why this exists: the create path fails silently by construction. Reels.jsx polls for a
 * reel_edls row and at 90s calls setAwaitingReelId(null) with no error, toast, or card.
 * Three studios' worth of uploads reached storage with no matching row and nobody found
 * out for a month; a further class of failure never reaches storage at all and leaves no
 * trace anywhere. Nothing in the system observed either.
 *
 * This writes to public.upload_events (FAR spec v0.3 §7 columns, §6 stage vocabulary).
 * It is NOT generation_events — that table is LLM-call shaped and service_role-written by
 * n8n. This one is written by the browser as `authenticated`, the opposite trust model.
 *
 * THE EMITTER MUST NEVER BREAK THE UPLOAD. Every entry point swallows its own transport
 * errors. It must also never fail *silently* — a vanished emit is the exact defect being
 * fixed one layer down — so every drop path logs, and there is now a beacon of last resort.
 *
 * THREE SCHEMA FACTS THE CALLER CANNOT IGNORE (migrations 20260902164500 / 20260902170000):
 *   occurred_at has NO default any more. If we do not stamp it, the insert fails. That is
 *     deliberate: the old default meant a client that forgot to stamp got a SERVER time in
 *     the client column, indistinguishable from a real one.
 *   source has NO default any more, for the same reason — an unlabelled row used to be
 *     silently relabelled 'client'.
 *   event_type is NOT NULL and CHECK-constrained to 20 values. It is derived here as
 *     `${stage}_${outcome}`; inventing a stage name is rejected at insert, not ignored.
 *
 * KNOWN GAP — the Supabase channel and the alert channel share one JWT. The upload_events
 * INSERT policy requires an authenticated role. A failure *caused by* a dead session cannot
 * write a row. That is what BEACON is for: /.netlify/functions/reel-telemetry accepts
 * unauthenticated posts and inserts service-side, so the session-death class is now
 * recordable. It was not before.
 */
import { supabase } from './supabase'

const QUEUE_KEY = 'fca_upload_events_queue'
const QUEUE_MAX = 50
const RAW_MAX_CHARS = 4000
const BEACON_URL = '/.netlify/functions/reel-telemetry'

/** Delivery outcomes. Tri-state on purpose: 'queued' is not 'dropped'. */
export const DELIVERED = 'delivered'
export const QUEUED = 'queued'
export const DROPPED = 'dropped'
export const BEACONED = 'beaconed'

/** §6 stages. The ONLY legal values for `stage`. */
export const STAGE = {
  FILE_SELECTED: 'file_selected',
  SESSION_CHECKED: 'session_checked',
  TRANSMIT_STARTED: 'transmit_started',
  TRANSMIT_COMPLETED: 'transmit_completed',
  TRANSMIT_ABANDONED: 'transmit_abandoned',
  CREATE_REQUEST_SENT: 'create_request_sent',
  STORAGE_OBJECT_VERIFIED: 'storage_object_verified',
  WF1_TRIGGERED: 'wf1_triggered',
}
export const OK = 'ok'
export const FAIL = 'fail'

export const APP_VERSION = '2b.1'

/** Stamped at FIRST FILE SELECT, not at submit. An attempt that is abandoned before submit
 *  is still an attempt, and it is the one class we could never see. */
export function newAttemptId() {
  return crypto.randomUUID()
}

/** Non-reversible, stable-per-name identifier. The filename can carry a person's name or a
 *  client's; the useful signal is "same file retried" / "same file across studios", which a
 *  hash preserves and the plaintext is not needed for. Synchronous FNV-1a — crypto.subtle is
 *  async and this runs on the picker's hot path. */
export function nameHash(name) {
  let h = 0x811c9dc5
  const s = String(name || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return 'h' + h.toString(16).padStart(8, '0') + '.' + s.length
}

export function pwaMode() {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return 'standalone'
    if (window.navigator.standalone) return 'ios-standalone'
    return 'browser'
  } catch { return 'unknown' }
}

/**
 * Redact credential-shaped substrings before anything leaves the browser.
 *
 * Error messages and response bodies are not authored by us. A storage 4xx can echo a
 * signed URL, and a signed URL carries a token; a JWT can arrive inside a stringified
 * request. Once such a value is in a row it is in every export of that row forever. Masked
 * to 8 chars, matching the standing credential rule.
 */
export function scrub(value) {
  if (value == null) return value
  if (typeof value !== 'string') {
    try { return JSON.parse(scrub(JSON.stringify(value))) } catch { return value }
  }
  return value
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, (m) => m.slice(0, 8) + '…')
    .replace(/\b(sb|sk|rk|pk|whsec|nfp)_[A-Za-z0-9_-]{12,}/g, (m) => m.slice(0, 8) + '…')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{12,}/g, (m) => m.slice(0, 8) + '…')
    .replace(/([?&](token|apikey|api_key|access_token|signature|sig|X-Amz-Signature)=)[^&\s]+/gi,
      (_, p) => p + '…')
}

/**
 * Flatten an unknown throwable without swallowing it.
 * Supabase StorageApiError carries status/statusCode and a message; a network failure is a
 * bare TypeError; a thrown string is neither. Capture all of it, keep a length-capped `raw`
 * so an unanticipated shape is still legible later.
 */
function serializeError(err) {
  if (err == null) return { message: 'unknown error (null/undefined thrown)' }
  if (typeof err !== 'object') return { message: scrub(String(err)), name: typeof err }

  let raw = null
  try {
    const s = JSON.stringify(err, Object.getOwnPropertyNames(err))
    const scrubbed = scrub(s)
    raw = scrubbed && scrubbed.length > RAW_MAX_CHARS
      ? { truncated: true, original_length: scrubbed.length, head: scrubbed.slice(0, RAW_MAX_CHARS) }
      : JSON.parse(scrubbed)
  } catch {
    raw = { unserializable: true }
  }

  return {
    message: scrub(err.message ?? String(err)),
    name: err.name ?? null,
    status: err.status ?? null,
    statusCode: err.statusCode ?? null,
    code: err.code ?? null,
    raw,
  }
}

/** A schema/validation rejection will fail identically forever — re-queueing it poisons the
 *  queue and traps every later event behind it. Auth and network failures are transient. */
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
  } catch { return [] }
}

function writeQueue(rows) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(rows.slice(-QUEUE_MAX)))
    return true
  } catch (e) {
    console.warn('[uploadTelemetry] queue write failed, events dropped:', e?.name, e?.message)
    return false
  }
}

/** Last resort. Unauthenticated, service-side insert. Returns true if the browser accepted
 *  the beacon for delivery — NOT that the server stored it. sendBeacon survives page unload,
 *  which fetch does not, and that is the entire point for transmit_abandoned. */
function beacon(rows) {
  try {
    const body = JSON.stringify({ rows: Array.isArray(rows) ? rows : [rows] })
    if (navigator.sendBeacon) {
      return navigator.sendBeacon(BEACON_URL, new Blob([body], { type: 'application/json' }))
    }
    // keepalive fetch is the fallback where sendBeacon is unavailable.
    fetch(BEACON_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
    }).catch(() => {})
    return true
  } catch (e) {
    console.warn('[uploadTelemetry] beacon failed:', e?.message)
    return false
  }
}

/**
 * Replay anything a previous emit could not deliver, one row at a time.
 * Row-by-row, not a batch: PostgREST fails an entire multi-row insert if any single row is
 * invalid, so one bad row would block every good one behind it permanently.
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
        continue
      }
      unsent.push(row)
    } catch (e) {
      console.warn('[uploadTelemetry] replay transport failure, retaining queue:', e?.message)
      unsent.push(...queued.slice(i))
      break
    }
  }
  writeQueue(unsent.concat(readQueue().filter((r) => !queued.includes(r))))
}

/** Build a row. Every §7 field the caller did not supply stays absent rather than guessed. */
function buildRow(attemptId, stage, outcome, fields = {}) {
  const {
    studio_id = null, reel_id = null, clip_index = null, clip_count = null,
    file_size_bytes = null, mime_type = null, elapsed_ms = null,
    storage_bucket = null, storage_path = null, observed_bytes = null,
    http_status = null, error_code = null, error_message = null,
    payload = {},
  } = fields

  return {
    attempt_id: attemptId,
    stage,
    outcome,
    // Derived, never passed in. The CHECK constraint permits exactly these 20 combinations.
    event_type: `${stage}_${outcome}`,
    // When it HAPPENED. created_at is the server default and records when it ARRIVED.
    // Both are needed: a queued event replayed minutes later is late by design, and collapsed
    // into one column that replay is indistinguishable from a fresh event.
    occurred_at: new Date().toISOString(),
    // No column default any more — an unlabelled row must not be silently called 'client'.
    source: 'client',
    studio_id, reel_id, clip_index, clip_count,
    file_size_bytes, mime_type, elapsed_ms,
    storage_bucket, storage_path, observed_bytes, http_status,
    error_code,
    error_message: scrub(error_message),
    payload: scrub({ app_version: APP_VERSION, ...payload }),
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
  }
}

/**
 * Write one event. Returns DELIVERED | QUEUED | BEACONED | DROPPED. Never throws.
 *
 * Escalation order: direct insert -> beacon (if there is no usable session, or the insert
 * failed) -> localStorage queue. The beacon comes BEFORE the queue because a queued row
 * only lands if this browser returns; a beacon lands now.
 */
export async function emit(attemptId, stage, outcome, fields = {}) {
  const row = buildRow(attemptId, stage, outcome, fields)

  try {
    // No session means the authenticated INSERT policy will reject us. Do not spend a
    // round trip discovering that — go straight to the channel that works without one.
    const { data } = await supabase.auth.getSession()
    if (!data?.session) {
      console.warn('[uploadTelemetry] no session, beaconing:', row.event_type)
      return beacon(row) ? BEACONED : (writeQueue(readQueue().concat([row])) ? QUEUED : DROPPED)
    }

    await flushQueue()
    const { error } = await supabase.from('upload_events').insert(row)
    if (!error) return DELIVERED

    if (isPermanentRejection(error)) {
      // A permanent rejection is a bug in this file (bad stage, bad outcome, unknown column).
      // Beacon it anyway: the server-side path shape-validates and will either store it or
      // log the rejection where we can see it. Silence is the one unacceptable outcome.
      console.error('[uploadTelemetry] permanently rejected, beaconing:',
        error.code || error.status, error.message, row.event_type)
      return beacon(row) ? BEACONED : DROPPED
    }
    console.warn('[uploadTelemetry] insert failed, beaconing:', error.message, row.event_type)
    if (beacon(row)) return BEACONED
    return writeQueue(readQueue().concat([row])) ? QUEUED : DROPPED
  } catch (e) {
    console.warn('[uploadTelemetry] emit threw, beaconing:', e?.message, row.event_type)
    if (beacon(row)) return BEACONED
    return writeQueue(readQueue().concat([row])) ? QUEUED : DROPPED
  }
}

/**
 * Failure event + Slack page, in that order.
 * The row is the durable record and is written first; Slack is a notification and may fail
 * without costing us the row. Callers should NOT await this on a user-visible path — set
 * the error state first.
 */
export async function emitFailure(attemptId, stage, fields = {}, err = null) {
  const e = err ? serializeError(err) : null
  const outcome = await emit(attemptId, stage, FAIL, {
    ...fields,
    http_status: fields.http_status ?? e?.status ?? e?.statusCode ?? null,
    error_code: fields.error_code ?? e?.code ?? e?.name ?? null,
    error_message: fields.error_message ?? e?.message ?? null,
    payload: { ...(fields.payload || {}), error_detail: e?.raw ?? null },
  })

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
        stage,
        file_size_bytes: fields.file_size_bytes ?? null,
        mime_type: fields.mime_type ?? null,
        elapsed_ms: fields.elapsed_ms ?? null,
        row_outcome: outcome,
        error_message: scrub(fields.error_message ?? e?.message ?? null),
        error_status: fields.http_status ?? e?.status ?? e?.statusCode ?? null,
      }),
    })
  } catch (ex) {
    console.warn('[uploadTelemetry] Slack alert failed (row outcome: ' + outcome + '):', ex?.message)
  }

  return outcome
}

/**
 * Abandonment. Registered by a surface while an upload is in flight; call the returned
 * function to disarm once the attempt reaches a terminal stage.
 *
 * pagehide, not beforeunload/unload: it is the only one that fires reliably on mobile
 * Safari's bfcache path, which is where a backgrounded upload actually dies. The row goes
 * out by beacon unconditionally — an async insert cannot complete during unload.
 */
export function armAbandonBeacon(attemptId, getFields) {
  const handler = () => {
    try {
      const row = buildRow(attemptId, STAGE.TRANSMIT_ABANDONED, FAIL, getFields() || {})
      beacon(row)
      const q = readQueue()
      if (q.length) beacon(q)
    } catch { /* unload path: never throw */ }
  }
  window.addEventListener('pagehide', handler)
  return () => window.removeEventListener('pagehide', handler)
}

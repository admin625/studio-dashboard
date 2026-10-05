/**
 * The final outcome of any generation run that carries a `client_request_id` — slot-bound or
 * owner-initiated — read off `generation_attempts`.
 *
 * WHY THIS EXISTS (HQ item 7, 2026-09-21). generate-content.js answers 202 at 25s and runs take
 * 48-85s, so the generator's own answer never reached the modal. On 2026-09-20 two of Katie's
 * three taps failed review and delivered nothing while the modal said success (execs 71021,
 * 71024). The generator now writes its terminal onto the attempt row, keyed by the
 * `client_request_id` the modal sends, and this module reads it back.
 *
 * States, and the only ways to reach them:
 *   generating    — no terminal yet, inside the deadline
 *   delivered     — outcome 'delivered' (a content_deliveries row exists; delivery_id is set)
 *   flagged       — outcome 'delivered_flagged' (WO-4): delivered, but not clean after the single
 *                   refine. The delivery carries quality_flag + a reason code; the owner sees
 *                   "Check before posting", one reason line and Regenerate (lib/qualityFlag.js)
 *   refused       — a slot rule (outcome 'refused'), or an entitlement / no-studio refusal
 *                   (synchronous body) stopped it before any model call
 *   failed        — outcome 'failed': the generator itself reported it created nothing
 *   no_answer     — no terminal arrived in time. Reported as exactly that, never as success
 *                   and never as "nothing was created": the run may still finish.
 *
 * 🚨 "No row" is NEVER read as "never started" (2026-09-21 review). Under RLS a filtered or
 * denied read returns no row with no error, and a failed Log Attempt insert leaves no row while
 * the run carries on and delivers. Both look exactly like "no row", so "nothing was created"
 * would be a false claim that invites a duplicate generation.
 *
 * 'needs_review' (two failed reflection passes, nothing delivered) is no longer a state. Until
 * the WO-4 Phase 4 port the live generator still writes it, so it is read as `failed` (which is
 * true: nothing was created), never with the critic's notes. Critic output is internal (doctrine
 * §3), and get_generation_outcome() strips it as well.
 *
 * No automatic retry anywhere. Regenerate on a flagged delivery is the owner's one tap, never ours.
 */

export const POLL_MS = 4000
/** No terminal after this long: no_answer. AI images add ~1 min each, so be generous. */
export const NO_ANSWER_MS = 10 * 60 * 1000

export const TERMINAL = ['delivered', 'flagged', 'refused', 'failed', 'no_answer']

/** A flagged run DID deliver: every consumer that reacts to a delivery treats both the same (D4). */
export const isDeliveredPhase = (phase) => phase === 'delivered' || phase === 'flagged'

/** Not terminal yet: still generating until the deadline, then no_answer. The one deadline rule. */
const pending = (elapsedMs) => (elapsedMs >= NO_ANSWER_MS ? { phase: 'no_answer' } : { phase: 'generating' })

/**
 * The flag of a flagged run. The delivery's own columns win (get_generation_outcome() returns
 * them); outcome_detail is the fallback, because the generator writes the reason there too and an
 * RPC from before the flag columns returns only that.
 */
function flagOf(row, detail) {
  const d = detail && typeof detail === 'object' ? detail : {}
  return {
    reason: row.flag_reason || d.flag_reason || null,
    phrase: row.flag_phrase || d.flag_phrase || null,
  }
}

/** Map one attempt row (or null) plus elapsed time to a state. Pure. */
export function classifyAttempt(row, elapsedMs) {
  if (!row) return pending(elapsedMs)
  const detail = row.outcome_detail || null
  switch (row.outcome) {
    case 'delivered':
      // A 'delivered' row whose delivery is flagged is still flagged: the delivery is the truth.
      if (row.quality_flag === true) return { phase: 'flagged', deliveryId: row.delivery_id || null, flag: flagOf(row, detail) }
      return { phase: 'delivered', deliveryId: row.delivery_id || null, detail }
    case 'delivered_flagged': return { phase: 'flagged', deliveryId: row.delivery_id || null, flag: flagOf(row, detail) }
    // Pre-port live generator only. Nothing was created; the critic's notes are not carried.
    case 'needs_review': return { phase: 'failed', detail: null }
    case 'refused': return { phase: 'refused', detail }
    case 'failed': return { phase: 'failed', detail }
    default: return pending(elapsedMs)
  }
}

/**
 * The generator can also answer synchronously (a refusal happens before any model call, well
 * inside 25s). Returns a terminal state for a body that carries one, else null (keep polling).
 */
export function classifySyncBody(body) {
  if (!body || typeof body !== 'object') return null
  // The pre-port live generator's Respond Needs Review body. Read as failed, notes dropped.
  if (body.needs_review === true) {
    return { phase: 'failed', detail: null }
  }
  if (body.refused === true) {
    return { phase: 'refused', detail: { code: body.code || null, message: body.message || null } }
  }
  return null
}

/**
 * One read of the outcome for this request, via get_generation_outcome(): a caller gets the
 * outcome of a request id they hold and nothing else (HQ 2026-09-21: reviewer notes on an owner's
 * runs are the owner's). generation_attempts itself has no read policy.
 */
export async function fetchAttempt(supabase, requestId) {
  const { data, error } = await supabase.rpc('get_generation_outcome', { p_client_request_id: requestId })
  if (error) throw error
  return Array.isArray(data) && data.length ? data[0] : null
}

/**
 * Poll until a terminal state. `fetchRow` is injected so tests drive it without a network.
 * A failed read is not a terminal: it is retried on the next tick, and only the deadline ends
 * the wait. Resolves with the terminal state; stops early (resolving null) if `isCancelled()`.
 */
export async function pollOutcome({ fetchRow, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isCancelled = () => false, onState = () => {} }) {
  const t0 = now()
  let loggedReadError = false
  for (;;) {
    if (isCancelled()) return null
    let row = null
    let readOk = true
    try { row = await fetchRow() } catch (e) {
      readOk = false
      // A missing or denied RPC fails every tick and would read as a slow run for 10 minutes.
      // Say so once, so it is at least visible in the console.
      if (!loggedReadError) { loggedReadError = true; console.warn('[generationOutcome] outcome read failed; retrying until the deadline:', e && (e.message || e.code || e)) }
    }
    if (isCancelled()) return null
    const elapsed = now() - t0
    const state = readOk ? classifyAttempt(row, elapsed) : pending(elapsed)
    onState(state)
    if (TERMINAL.includes(state.phase)) return state
    await sleep(POLL_MS)
  }
}

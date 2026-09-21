/**
 * The final outcome of a slot-bound generation, read off `generation_attempts`.
 *
 * WHY THIS EXISTS (HQ item 7, 2026-09-21). generate-content.js answers 202 at 25s and a slot run
 * takes 48-83s, so the generator's own answer never reached the modal. On 2026-09-20 two of
 * Katie's three taps failed review and delivered nothing while the modal said success
 * (execs 71021, 71024). The generator now writes its terminal onto the attempt row, keyed by the
 * `client_request_id` the modal sends, and this module reads it back.
 *
 * States, and the only ways to reach them:
 *   generating    — no row yet, or a row with outcome NULL, and still inside the deadlines
 *   delivered     — outcome 'delivered' (a content_deliveries row exists; delivery_id is set)
 *   needs_review  — outcome 'needs_review': two reflection passes failed, NOTHING was delivered
 *   refused       — outcome 'refused': a slot rule stopped it before any model call
 *   failed        — outcome 'failed', or no attempt row ever appeared (the run never started)
 *   no_answer     — a row exists but no terminal arrived in time. Reported as exactly that,
 *                   never as success: the run may still finish, or may have died mid-way.
 *
 * Deliberately no automatic retry anywhere. A needs-review draft is a human's call, not a
 * transient error, and a retry would bury the one signal this exists to surface.
 */

export const POLL_MS = 4000
/** No attempt row at all after this long: the run never reached Log Attempt. */
export const NO_ROW_MS = 90 * 1000
/** A row but no terminal after this long. AI images add ~1 min each, so be generous. */
export const NO_ANSWER_MS = 10 * 60 * 1000

export const TERMINAL = ['delivered', 'needs_review', 'refused', 'failed', 'no_answer']

/** Map one attempt row (or null) plus elapsed time to a state. Pure. */
export function classifyAttempt(row, elapsedMs) {
  if (!row) return elapsedMs >= NO_ROW_MS ? { phase: 'failed', reason: 'not_started' } : { phase: 'generating' }
  const detail = row.outcome_detail || null
  switch (row.outcome) {
    case 'delivered': return { phase: 'delivered', deliveryId: row.delivery_id || null, detail }
    case 'needs_review': return { phase: 'needs_review', detail }
    case 'refused': return { phase: 'refused', detail }
    case 'failed': return { phase: 'failed', reason: 'generator', detail }
    default: return elapsedMs >= NO_ANSWER_MS ? { phase: 'no_answer' } : { phase: 'generating' }
  }
}

/**
 * The generator can also answer synchronously (a refusal happens before any model call, well
 * inside 25s). Returns a terminal state for a body that carries one, else null (keep polling).
 */
export function classifySyncBody(body) {
  if (!body || typeof body !== 'object') return null
  if (body.needs_review === true) {
    return { phase: 'needs_review', detail: { failed_criteria: body.failed_criteria || [], notes: body.notes || null } }
  }
  if (body.refused === true) {
    return { phase: 'refused', detail: { code: body.code || null, message: body.message || null } }
  }
  return null
}

/** One read of the attempt row for this request. Owner-readable under RLS. */
export async function fetchAttempt(supabase, requestId) {
  const { data, error } = await supabase
    .from('generation_attempts')
    .select('outcome, outcome_detail, delivery_id')
    .eq('client_request_id', requestId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

/**
 * Poll until a terminal state. `fetchRow` is injected so tests drive it without a network.
 * A failed read is not a terminal: it is retried on the next tick, and only the deadlines end
 * the wait. Resolves with the terminal state; stops early (resolving null) if `isCancelled()`.
 */
export async function pollOutcome({ fetchRow, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isCancelled = () => false, onState = () => {} }) {
  const t0 = now()
  for (;;) {
    if (isCancelled()) return null
    let row = null
    let readOk = true
    try { row = await fetchRow() } catch { readOk = false }
    if (isCancelled()) return null
    const elapsed = now() - t0
    // A failed read proves nothing about the run, so it can never produce "not started".
    const state = readOk ? classifyAttempt(row, elapsed) : (elapsed >= NO_ANSWER_MS ? { phase: 'no_answer' } : { phase: 'generating' })
    onState(state)
    if (TERMINAL.includes(state.phase)) return state
    await sleep(POLL_MS)
  }
}

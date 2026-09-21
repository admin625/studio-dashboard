import { describe, it, expect } from 'vitest'
import {
  classifyAttempt, classifySyncBody, pollOutcome, fetchAttempt, NO_ANSWER_MS, POLL_MS,
} from '../src/lib/generationOutcome.js'
import { slotDatesByPost } from '../src/lib/slotDate.js'

/**
 * Item 7, HQ 2026-09-21. The modal must learn how a slot run ended.
 *
 * REAL_NEEDS_REVIEW is the row the generator wrote for the deliberate-failure receipt
 * (disposable copy of pTTpsIlhtOYHqvXd, exec 71271, 2026-09-21 17:08:26 UTC) — read back from
 * generation_attempts, not typed from the design. The caller had been cut off at 25s, exactly
 * as generate-content.js does, so this row is the ONLY place the outcome existed.
 */
const REAL_NEEDS_REVIEW = {
  outcome: 'needs_review',
  outcome_detail: {
    notes: 'Deliberate failure: item-7 needs-review receipt.',
    slot_id: '2073eacd-78ab-4c80-ab88-18e6612b11c7',
    iterations: 2,
    failed_criteria: ['hqtest_forced_fail'],
  },
  delivery_id: null,
}

describe('classifyAttempt', () => {
  it('the real needs_review row is needs_review, never success', () => {
    const s = classifyAttempt(REAL_NEEDS_REVIEW, 46_000)
    expect(s.phase).toBe('needs_review')
    expect(s.detail.iterations).toBe(2)
  })
  it('delivered carries the delivery id', () => {
    expect(classifyAttempt({ outcome: 'delivered', delivery_id: 'd1' }, 1)).toMatchObject({ phase: 'delivered', deliveryId: 'd1' })
  })
  it('refused and failed are their own states', () => {
    expect(classifyAttempt({ outcome: 'refused', outcome_detail: { message: 'held' } }, 1).phase).toBe('refused')
    expect(classifyAttempt({ outcome: 'failed' }, 1).phase).toBe('failed')
  })
  it('a row with no outcome is generating until the no-answer deadline, then no_answer (not success)', () => {
    const open = { outcome: null, outcome_detail: null, delivery_id: null }
    expect(classifyAttempt(open, NO_ANSWER_MS - 1).phase).toBe('generating')
    expect(classifyAttempt(open, NO_ANSWER_MS).phase).toBe('no_answer')
  })
  it('no row is NEVER "nothing was created": generating, then no_answer (RLS-filtered reads and a failed Log Attempt both look like this)', () => {
    expect(classifyAttempt(null, 90_000).phase).toBe('generating')
    expect(classifyAttempt(null, NO_ANSWER_MS)).toEqual({ phase: 'no_answer' })
  })
  it('only the generator can say failed', () => {
    expect(classifyAttempt({ outcome: 'failed', outcome_detail: { error: 'prompt_field_missing' } }, 1)).toMatchObject({ phase: 'failed' })
  })
})

describe('classifySyncBody', () => {
  it("the generator's own Respond Needs Review body (exec 71021's shape) is needs_review", () => {
    // Verbatim shape of the 2026-09-20 body the modal used to treat as success: no `error` key.
    const body = { ok: false, needs_review: true, generated: false, delivered: false, iterations: 2,
      failed_criteria: ['no_generic_cliches'], notes: 'Post 1 uses …', message: 'Draft did not pass critique after two passes.' }
    expect(classifySyncBody(body).phase).toBe('needs_review')
  })
  it('Refuse Held Slot body is refused', () => {
    expect(classifySyncBody({ ok: false, refused: true, code: 'slot_held', message: 'This slot is held.' }).phase).toBe('refused')
  })
  it("the proxy's 202 body is not terminal — keep polling", () => {
    expect(classifySyncBody({ success: true, message: 'Content generation in progress.' })).toBeNull()
    expect(classifySyncBody(null)).toBeNull()
  })
})

describe('pollOutcome', () => {
  const clock = () => {
    let t = 0
    return { now: () => t, sleep: async (ms) => { t += ms } }
  }
  it('follows a run from open row to the real needs_review row', async () => {
    const c = clock()
    const rows = [null, { outcome: null }, { outcome: null }, REAL_NEEDS_REVIEW]
    const seen = []
    const final = await pollOutcome({ fetchRow: async () => (rows.length ? rows.shift() : REAL_NEEDS_REVIEW), ...c, onState: (s) => seen.push(s.phase) })
    expect(final.phase).toBe('needs_review')
    expect(seen).toEqual(['generating', 'generating', 'generating', 'needs_review'])
    expect(c.now()).toBe(3 * POLL_MS)
  })
  it('read errors are retried and can never produce "not started"', async () => {
    const c = clock()
    let n = 0
    const final = await pollOutcome({
      fetchRow: async () => { n += 1; if (n < 40) throw new Error('network'); return { outcome: 'delivered', delivery_id: 'd' } },
      ...c,
    })
    expect(final.phase).toBe('delivered')
    expect(c.now()).toBeGreaterThan(90_000) // long after the old 90s no-row cut, and still not "failed"
  })
  it('stops when cancelled, resolving null', async () => {
    const c = clock()
    let cancelled = false
    const p = pollOutcome({ fetchRow: async () => { cancelled = true; return { outcome: null } }, ...c, isCancelled: () => cancelled })
    expect(await p).toBeNull()
  })
})

describe('slotDatesByPost', () => {
  it('keys each post by platform:post_index', () => {
    const rows = [
      { platform: 'instagram', post_index: 0, calendar_slots: { slot_date: '2026-10-08' } },
      { platform: 'tiktok', post_index: 0, calendar_slots: { slot_date: '2026-10-08' } },
    ]
    expect(slotDatesByPost(rows)).toEqual({ 'instagram:0': '2026-10-08', 'tiktok:0': '2026-10-08' })
  })
  it('a post with no slot gets no date — never a guessed one', () => {
    expect(slotDatesByPost([{ platform: 'instagram', post_index: 0, calendar_slots: null }])).toEqual({})
    expect(slotDatesByPost(null)).toEqual({})
  })
})

describe('review fixes (2026-09-21 full /review)', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms } } }

  it('an RLS-filtered read (null, no error) forever ends in no_answer — never failed', async () => {
    const c = clock()
    const final = await pollOutcome({ fetchRow: async () => null, ...c })
    expect(final).toEqual({ phase: 'no_answer' })
    expect(c.now()).toBeGreaterThanOrEqual(NO_ANSWER_MS)
  })
  it('reads that always throw end in no_answer at the deadline — the loop cannot spin forever', async () => {
    const c = clock()
    const final = await pollOutcome({ fetchRow: async () => { throw new Error('net') }, ...c })
    expect(final).toEqual({ phase: 'no_answer' })
    expect(c.now()).toBeGreaterThanOrEqual(NO_ANSWER_MS)
  })
})

describe('fetchAttempt', () => {
  const client = (result) => {
    const calls = {}
    return { calls, sb: { rpc: async (fn, args) => { calls.fn = fn; calls.args = args; return result }, from: () => { throw new Error('direct table read: must go through the RPC') } } }
  }
  it('asks get_generation_outcome for exactly this request id — never reads the table', async () => {
    const { calls, sb } = client({ data: [{ outcome: null }], error: null })
    expect(await fetchAttempt(sb, 'rid')).toEqual({ outcome: null })
    expect(calls.fn).toBe('get_generation_outcome')
    expect(calls.args).toEqual({ p_client_request_id: 'rid' })
  })
  it('a Supabase error is thrown (so the poll retries it), never turned into "no row"', async () => {
    const { sb } = client({ data: null, error: { message: 'x' } })
    await expect(fetchAttempt(sb, 'rid')).rejects.toEqual({ message: 'x' })
  })
  it('no row (not found, or not yours — indistinguishable by design) is null', async () => {
    expect(await fetchAttempt(client({ data: [], error: null }).sb, 'rid')).toBeNull()
    expect(await fetchAttempt(client({ data: null, error: null }).sb, 'rid')).toBeNull()
  })
})

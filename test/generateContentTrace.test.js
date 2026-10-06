import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/**
 * C5 (Mac 2026-10-05/06). generate-content.js writes one durable generate_proxy_calls row per
 * call: INSERT on entry (awaited before n8n is called), PATCH with the outcome before it returns.
 * Counts and ids only. A trace write failure never blocks the generation; it fires an alert.
 *
 * Why: Katie's 2026-09-29 22:30Z tap left no record anywhere, so "didn't press Create", "the
 * proxy refused" and "n8n header auth 403" could not be told apart.
 *
 * Same VM-sandbox harness as generateContentProxyKey.test.js. The fake PostgREST keeps the trace
 * table in memory and applies POST/PATCH the way PostgREST would, including count=exact.
 * C5_SRC lets the negative control load the pre-C5 file: every test here must fail against it.
 */
const SRC = process.env.C5_SRC
  ? readFileSync(process.env.C5_SRC, 'utf8')
  : readFileSync(new URL('../netlify/functions/generate-content.js', import.meta.url), 'utf8')
const WEBHOOK = 'https://n8n.example.test/webhook/fca-studio-agent'
const SLACK = 'https://hooks.slack.example.test/services/T000/B000/unit'
const SUPA = 'https://supa.example.test'
const KEY = 'unit-test-proxy-key-'.repeat(3)
const SERVICE = 'unit-test-service-role-'.repeat(2)
const STUDIO = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'
const REQ = 'cccccccc-0000-4000-8000-00000000000a'
const SLOT = 'dddddddd-0000-4000-8000-00000000000b'
const USER = 'eeeeeeee-0000-4000-8000-00000000000c'
const IG = [{ name: 'instagram', postCount: 3, includeImages: true, formats: ['feed_post'] }]
const POST_TEXT = 'Secret post text the generator wrote'

// Every column the migration defines. A row key outside this set fails the PostgREST write in
// production, so the fake rejects it too.
const COLUMNS = new Set([
  'id', 'created_at', 'updated_at', 'client_request_id', 'studio_id', 'slot_id', 'client_id',
  'regenerate_of', 'auth_user_id', 'caller_role', 'platform_count', 'posts_requested', 'outcome',
  'refusal_reason', 'response_status', 'generator_key_sent', 'forwarded_at', 'n8n_status',
  'n8n_ms', 'duration_ms', 'completed_at',
])

const param = (url, name) => { const m = url.match(new RegExp('[?&]' + name + '=eq\\.([^&]+)')); return m ? decodeURIComponent(m[1]) : null }

// The migration's CHECK constraints, applied to the merged row the way Postgres would. A close
// that breaks one fails in production (PATCH 400, row stays outcome null), so it fails here too.
const REASON_RE = /^[a-z0-9_]{1,48}$/
function violates(r) {
  const n = (v) => v === undefined || v === null
  if (!n(r.caller_role) && !['studio_owner', 'studio_instructor'].includes(r.caller_role)) return 'caller_role'
  if (!n(r.outcome) && !['refused', 'n8n_response', 'n8n_timeout', 'n8n_network_error'].includes(r.outcome)) return 'outcome'
  if (!n(r.refusal_reason) && !REASON_RE.test(r.refusal_reason)) return 'refusal_reason'
  for (const k of ['platform_count', 'posts_requested', 'n8n_ms', 'duration_ms']) if (!n(r[k]) && r[k] < 0) return k
  // A CHECK passes when it evaluates to NULL, so these only bite once outcome is set.
  if (!n(r.outcome) && (r.outcome === 'refused') !== !n(r.refusal_reason)) return 'reason_iff_refused'
  if (!n(r.outcome) && (r.outcome === 'n8n_response') !== !n(r.n8n_status)) return 'n8n_status_iff_response'
  if (r.outcome === 'refused' && !n(r.forwarded_at)) return 'refused_not_forwarded'
  return null
}

const FOREIGN_SLOT = 'dddddddd-0000-4000-8000-0000000000ff'
const SLOTS = [{ id: SLOT, studio_id: STUDIO }, { id: FOREIGN_SLOT, studio_id: OTHER }]

function load({ upstream, trace = {}, env: envExtra = {}, owner = 'owner@example.test', who = owner, instructors = [], clients = [], authStatus = 200, slack = 'ok', slots = SLOTS } = {}) {
  const calls = []
  const logs = []
  const table = new Map()
  const order = []
  const timers = []
  const snapshots = []
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    if (url.endsWith('/auth/v1/user')) return { ok: authStatus === 200, status: authStatus, json: async () => ({ id: USER, email: who }) }
    if (url.includes('/rest/v1/generate_proxy_calls')) {
      expect(opts.headers.Authorization).toBe('Bearer ' + SERVICE)
      const row = JSON.parse(opts.body)
      for (const k of Object.keys(row)) if (!COLUMNS.has(k)) throw new Error('unknown column ' + k)
      if (opts.method === 'POST') {
        // Logged when the insert COMMITS (after the delay), so the order assertion measures
        // "row exists before n8n", not merely "insert was started before n8n".
        if (trace.insertDelay) await new Promise((r) => setTimeout(r, trace.insertDelay))
        // Hangs until the proxy's own timeout aborts it. 'committed' means the database took the
        // row anyway and only the reply was lost.
        if (trace.insertHangs) {
          if (trace.insertHangs === 'committed') table.set(row.id, { ...row })
          return new Promise((_, reject) => opts.signal.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e)
          }))
        }
        order.push('insert')
        if (trace.insertThrows) throw new TypeError('fetch failed')
        if (trace.insertStatus) return { ok: false, status: trace.insertStatus, headers: new Map() }
        table.set(row.id, { ...row })
        return { ok: true, status: 201, headers: new Map() }
      }
      if (opts.method === 'PATCH') {
        // The pre-n8n checkpoint PATCH has no completed_at; the close PATCH does.
        const closing = 'completed_at' in row
        order.push(closing ? 'close' : 'checkpoint')
        snapshots.push({ stage: closing ? 'close' : 'checkpoint', row: { ...row } })
        if (!closing && trace.checkpointStatus) return { ok: false, status: trace.checkpointStatus }
        if (closing && trace.updateStatus) return { ok: false, status: trace.updateStatus, headers: new Map() }
        if (closing && trace.updateThrows) throw new TypeError('fetch failed')
        expect(url).toContain('select=id')
        expect(opts.headers.Prefer).toBe('return=representation')
        const id = param(url, 'id')
        const hit = trace.updateMisses ? null : table.get(id)
        if (hit) {
          const bad = violates({ ...hit, ...row })
          if (bad) return { ok: false, status: 400, json: async () => ({ code: '23514', violated: bad }) }
          Object.assign(hit, row)
        }
        // return=representation with select=id: the touched rows' ids, [] when nothing matched.
        return { ok: true, status: 200, json: async () => (hit ? [{ id }] : []) }
      }
    }
    if (url.includes('/rest/v1/studio_accounts')) {
      return { ok: true, json: async () => [{ id: STUDIO, owner_email: owner }].filter((s) => s.id === param(url, 'id')) }
    }
    if (url.includes('/rest/v1/studio_instructors')) return { ok: true, json: async () => instructors }
    if (url.includes('/rest/v1/clients')) return { ok: true, json: async () => clients.filter((c) => c.id === param(url, 'id')) }
    if (url.includes('/rest/v1/content_deliveries')) return { ok: true, json: async () => [] }
    // RLS as PostgREST applies it: the caller sees only slots of a studio it owns.
    if (url.includes('/rest/v1/calendar_slots')) {
      return { ok: true, json: async () => slots.filter((x) => x.id === param(url, 'id') && x.studio_id === STUDIO && who === owner) }
    }
    if (url === WEBHOOK) { order.push('n8n'); return upstream(opts) }
    if (url === SLACK) {
      if (slack === 'throws') throw new TypeError('fetch failed')
      return { ok: slack === 'ok', status: slack === 'ok' ? 200 : 500 }
    }
    throw new Error('unexpected url ' + url)
  }
  const env = {
    N8N_WEBHOOK_URL: WEBHOOK, SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: 'anon',
    N8N_GENERATOR_KEY: KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SLACK_WEBHOOK_URL: SLACK, ...envExtra,
  }
  for (const k of Object.keys(env)) if (env[k] == null) delete env[k]
  const record = (level) => (...a) => logs.push({ level, text: a.map(String).join(' ') })
  // Records every timer the proxy schedules, so the n8n window can be asserted.
  const spySetTimeout = (fn, ms, ...a) => { timers.push(ms); return setTimeout(fn, ms, ...a) }
  const sandbox = {
    exports: {}, process: { env }, fetch, AbortController, setTimeout: spySetTimeout, clearTimeout,
    console: { log: record('log'), warn: record('warn'), error: record('error') },
  }
  sandbox.crypto = globalThis.crypto
  vm.runInNewContext(SRC, sandbox)
  return { handler: sandbox.exports.handler, calls, logs, table, order, timers, snapshots }
}

const event = (body = {}, headers = { authorization: 'Bearer user-jwt' }) => ({
  httpMethod: 'POST',
  headers,
  body: typeof body === 'string' ? body : JSON.stringify({
    email: 'owner@example.test', studio_id: STUDIO, client_request_id: REQ, slot_id: SLOT, platforms: IG, ...body,
  }),
})
const ok = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, posts: [{ text: POST_TEXT }] }) })
const status = (s) => () => ({ ok: false, status: s, text: async () => '{"message":"Authorization data is wrong!"}' })
const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
// Columns a write never set are NULL in the database, so they read as null here too.
const only = (table) => { expect(table.size).toBe(1); return { ...Object.fromEntries([...COLUMNS].map((c) => [c, null])), ...[...table.values()][0] } }
const slackPosts = (calls) => calls.filter((c) => c.url === SLACK)

describe('C5 control 1: a normal call leaves a complete row', () => {
  it('n8n answers 200: row has ids, counts, role, n8n status, timing and outcome', async () => {
    const { handler, table } = load({ upstream: ok })
    const res = await handler(event())
    expect(res.statusCode).toBe(200)
    const row = only(table)
    expect(row).toMatchObject({
      client_request_id: REQ, studio_id: STUDIO, slot_id: SLOT, auth_user_id: USER,
      caller_role: 'studio_owner', platform_count: 1, posts_requested: 3,
      outcome: 'n8n_response', n8n_status: 200, response_status: 200, refusal_reason: null,
      generator_key_sent: true,
    })
    for (const k of ['forwarded_at', 'completed_at', 'updated_at']) expect(typeof row[k]).toBe('string')
    for (const k of ['n8n_ms', 'duration_ms']) expect(Number.isInteger(row[k]) && row[k] >= 0).toBe(true)
  })

  it('the upstream-window abort (the usual path) closes as n8n_timeout with response 202', async () => {
    const { handler, table } = load({ upstream: abort })
    const res = await handler(event())
    expect(res.statusCode).toBe(202)
    expect(only(table)).toMatchObject({ outcome: 'n8n_timeout', n8n_status: null, response_status: 202 })
  })

  it('the row exists BEFORE n8n is called, even when the insert is slow', async () => {
    const { handler, order } = load({ upstream: ok, trace: { insertDelay: 30 } })
    await handler(event())
    expect(order).toEqual(['insert', 'checkpoint', 'n8n', 'close'])
  })

  it('a network failure to n8n closes as n8n_network_error, 502', async () => {
    const boom = () => { throw new TypeError('fetch failed: https://secret-webhook.example.test/x') }
    const { handler, table } = load({ upstream: boom })
    const res = await handler(event())
    expect(res.statusCode).toBe(502)
    expect(only(table)).toMatchObject({ outcome: 'n8n_network_error', n8n_status: null, response_status: 502 })
  })
})

describe('C5 control 2: a proxy refusal leaves a row with the reason', () => {
  it('another studio: refused / not_member / 403, and n8n is never called', async () => {
    const { handler, table, calls } = load({ upstream: ok })
    const res = await handler(event({ studio_id: OTHER }))
    expect(res.statusCode).toBe(403)
    expect(calls.some((c) => c.url === WEBHOOK)).toBe(false)
    // Session verified (auth_user_id kept), membership not: the unverified studio id is NOT stored.
    expect(only(table)).toMatchObject({
      studio_id: null, client_request_id: null, slot_id: null, auth_user_id: USER,
      outcome: 'refused', refusal_reason: 'not_member', response_status: 403,
      caller_role: null, forwarded_at: null, n8n_status: null,
    })
  })

  it('no token: refused / no_token / 401, and every id is null (Mac ruling 2026-10-06)', async () => {
    const { handler, table } = load({ upstream: ok })
    const res = await handler(event({}, {}))
    expect(res.statusCode).toBe(401)
    expect(only(table)).toMatchObject({
      outcome: 'refused', refusal_reason: 'no_token', response_status: 401,
      client_request_id: null, studio_id: null, slot_id: null, client_id: null, regenerate_of: null, auth_user_id: null,
    })
  })

  it('unparseable body: refused / invalid_json / 400, no ids', async () => {
    const { handler, table } = load({ upstream: ok })
    const res = await handler(event('{nope'))
    expect(res.statusCode).toBe(400)
    const row = only(table)
    expect(row).toMatchObject({ outcome: 'refused', refusal_reason: 'invalid_json', response_status: 400 })
    expect(row.studio_id).toBeNull()
  })

  it('too many posts: refused / bad_post_count', async () => {
    const { handler, table } = load({ upstream: ok })
    await handler(event({ platforms: [{ name: 'instagram', postCount: 6 }] }))
    expect(only(table)).toMatchObject({ outcome: 'refused', refusal_reason: 'bad_post_count', response_status: 400 })
  })

  it('a non-uuid id is not stored, it is dropped', async () => {
    const { handler, table } = load({ upstream: ok })
    await handler(event({ client_request_id: 'not-a-uuid', slot_id: "x' or 1=1" }))
    const row = only(table)
    expect(row.client_request_id).toBeNull()
    expect(row.slot_id).toBeNull()
  })
})

describe('C5 control 3: an n8n auth rejection leaves a row showing the 403 (the 09-29 case)', () => {
  it('n8n 403: outcome n8n_response, n8n_status 403, response 403, key was sent', async () => {
    const { handler, table } = load({ upstream: status(403) })
    const res = await handler(event())
    expect(res.statusCode).toBe(403)
    expect(only(table)).toMatchObject({
      outcome: 'n8n_response', n8n_status: 403, response_status: 403, refusal_reason: null,
      generator_key_sent: true, caller_role: 'studio_owner',
    })
  })

  it('n8n 403 with NO key configured (a preview deploy) records generator_key_sent false', async () => {
    const { handler, table } = load({ upstream: status(403), env: { N8N_GENERATOR_KEY: null } })
    await handler(event())
    expect(only(table)).toMatchObject({ n8n_status: 403, generator_key_sent: false })
  })

  it('the proxy\'s own 403 and n8n\'s 403 are distinguishable from the row alone', async () => {
    const own = load({ upstream: ok })
    await own.handler(event({ studio_id: OTHER }))
    const up = load({ upstream: status(403) })
    await up.handler(event())
    const a = only(own.table); const b = only(up.table)
    expect(a.response_status).toBe(b.response_status)
    expect([a.outcome, a.n8n_status]).toEqual(['refused', null])
    expect([b.outcome, b.n8n_status]).toEqual(['n8n_response', 403])
  })
})

describe('C5: a trace write failure never blocks generation, and alerts', () => {
  for (const [name, trace] of [['insert 500', { insertStatus: 500 }], ['insert network error', { insertThrows: true }]]) {
    it(name + ': n8n still called, same response, one Slack alert, no update attempted', async () => {
      const { handler, calls, order, logs } = load({ upstream: ok, trace })
      const res = await handler(event())
      expect(res.statusCode).toBe(200)
      expect(calls.some((c) => c.url === WEBHOOK)).toBe(true)
      expect(order).toEqual(['insert', 'n8n'])
      expect(slackPosts(calls)).toHaveLength(1)
      expect(logs.some((l) => l.text.includes('generate_trace_write_failed'))).toBe(true)
    })
  }

  it('checkpoint 500: alert fires, n8n is still called, response unchanged', async () => {
    const { handler, calls } = load({ upstream: ok, trace: { checkpointStatus: 500 } })
    const res = await handler(event())
    expect(res.statusCode).toBe(200)
    expect(calls.some((c) => c.url === WEBHOOK)).toBe(true)
    expect(JSON.parse(slackPosts(calls)[0].opts.body).text).toContain('(checkpoint)')
  })

  it('update 500: alert fires, response unchanged', async () => {
    const { handler, calls } = load({ upstream: ok, trace: { updateStatus: 500 } })
    const res = await handler(event())
    expect(res.statusCode).toBe(200)
    expect(slackPosts(calls)).toHaveLength(1)
    expect(JSON.parse(slackPosts(calls)[0].opts.body).text).toContain('(update)')
  })

  it('update matched 0 rows (PostgREST 2xx): still an alert, not a silent no-op', async () => {
    const { handler, calls } = load({ upstream: ok, trace: { updateMisses: true } })
    await handler(event())
    expect(slackPosts(calls)).toHaveLength(1)
  })

  it('service key missing: generation runs, alert says not_configured', async () => {
    const { handler, calls, table } = load({ upstream: ok, env: { SUPABASE_SERVICE_ROLE_KEY: null } })
    const res = await handler(event())
    expect(res.statusCode).toBe(200)
    expect(table.size).toBe(0)
    expect(JSON.parse(slackPosts(calls)[0].opts.body).text).toContain('reason=not_configured')
  })

  it('a healthy call sends no alert', async () => {
    const { handler, calls } = load({ upstream: ok })
    await handler(event())
    expect(slackPosts(calls)).toHaveLength(0)
  })
})

describe('C5: counts and ids only', () => {
  it('no row, alert or log carries the email, post text, key, service key or n8n body', async () => {
    const forbidden = ['owner@example.test', POST_TEXT, KEY.slice(5, 30), SERVICE.slice(5, 30), 'Authorization data', 'instagram', 'feed_post']
    for (const [upstream, trace] of [[ok, {}], [status(403), {}], [ok, { updateStatus: 500 }], [ok, { insertStatus: 500 }]]) {
      const { handler, calls, logs, table } = load({ upstream, trace })
      await handler(event())
      const traceWrites = calls.filter((c) => c.url.includes('generate_proxy_calls')).map((c) => c.opts.body)
      const surfaces = [JSON.stringify([...table.values()]), ...traceWrites, ...slackPosts(calls).map((c) => c.opts.body), ...logs.map((l) => l.text)]
      for (const s of surfaces) for (const f of forbidden) expect(s.includes(f), f + ' leaked').toBe(false)
    }
  })
})

describe('C5 review follow-ups', () => {
  // Every refusal path a caller can reach, with the reason it must record.
  const TEACHER = { instructor_email: 'teacher@example.test' }
  const ROW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const cases = [
    ['session_rejected', 401, { authStatus: 401 }, {}],
    ['session_no_email', 401, { who: '' }, {}],
    ['bad_studio_id', 400, {}, { studio_id: 'nope' }],
    ['bad_client_id', 400, {}, { client_id: 'nope' }],
    ['no_platforms', 400, {}, { platforms: [] }],
    ['too_many_posts', 400, {}, { platforms: Array.from({ length: 6 }, () => ({ name: 'instagram', postCount: 5 })) }],
    ['client_not_in_studio', 400, { clients: [{ id: ROW, studio_id: OTHER, email: 'owner@example.test' }] }, { client_id: ROW }],
    ['client_not_caller', 403, { clients: [{ id: ROW, studio_id: STUDIO, email: 'someone@example.test' }] }, { client_id: ROW }],
    ['regenerate_not_owner', 403, { who: 'teacher@example.test', instructors: [TEACHER] }, { regenerate_of: ROW }],
    ['regenerate_invalid', 400, {}, { regenerate_of: 'nope' }],
    ['regenerate_not_visible', 403, {}, { regenerate_of: ROW }],
    ['not_configured', 500, { env: { N8N_WEBHOOK_URL: null } }, {}],
  ]
  for (const [reason, code, opts, body] of cases) {
    it('refusal ' + reason + ' records its reason and status', async () => {
      const { handler, table, calls } = load({ upstream: ok, ...opts })
      const res = await handler(event(body))
      expect(res.statusCode).toBe(code)
      expect(calls.some((c) => c.url === WEBHOOK)).toBe(false)
      expect(only(table)).toMatchObject({ outcome: 'refused', refusal_reason: reason, response_status: code, forwarded_at: null })
      expect(slackPosts(calls)).toHaveLength(0)
    })
  }

  it('every refusal reason in the source satisfies the column CHECK', () => {
    const reasons = [...SRC.matchAll(/refuse\(trace, \d+, '([^']+)'/g)].map((m) => m[1])
    expect(reasons.length).toBeGreaterThan(20)
    for (const r of reasons) expect(REASON_RE.test(r), r).toBe(true)
  })

  it('an instructor caller is recorded as studio_instructor', async () => {
    const { handler, table } = load({ upstream: ok, who: 'teacher@example.test', instructors: [TEACHER] })
    await handler(event())
    expect(only(table)).toMatchObject({ caller_role: 'studio_instructor', outcome: 'n8n_response' })
  })

  it('n8n 403 whose body read then fails stays n8n_response/403 (response 502), no alert', async () => {
    const up = () => ({ ok: false, status: 403, text: async () => { throw new TypeError('terminated') } })
    const { handler, table, calls } = load({ upstream: up })
    const res = await handler(event())
    expect(res.statusCode).toBe(502)
    expect(only(table)).toMatchObject({ outcome: 'n8n_response', n8n_status: 403, response_status: 502 })
    expect(slackPosts(calls)).toHaveLength(0)
  })

  it('the n8n window is 25s minus the close reserve minus time already spent', async () => {
    const { handler, timers } = load({ upstream: ok, trace: { insertDelay: 40 } })
    await handler(event())
    const windowMs = Math.max(...timers.filter((t) => t > 5000))
    // reserve = PATCH cap 1200 + alert cap 1500 + 300 margin = 3000
    expect(windowMs).toBeLessThanOrEqual(25000 - 3000 - 40)
    expect(windowMs).toBeGreaterThan(25000 - 3000 - 1000)
  })

  it('a hung insert times out at 3s, alerts, and n8n is still called', async () => {
    vi.useFakeTimers()
    try {
      const { handler, calls, table } = load({ upstream: ok, trace: { insertHangs: true } })
      const p = handler(event())
      await vi.advanceTimersByTimeAsync(3100)
      const res = await p
      expect(res.statusCode).toBe(200)
      expect(calls.some((c) => c.url === WEBHOOK)).toBe(true)
      expect(table.size).toBe(0)
      expect(JSON.parse(slackPosts(calls)[0].opts.body).text).toContain('error=AbortError')
    } finally { vi.useRealTimers() }
  })

  it('a timed-out insert that committed anyway still gets its outcome written', async () => {
    vi.useFakeTimers()
    try {
      const { handler, table } = load({ upstream: ok, trace: { insertHangs: 'committed' } })
      const p = handler(event())
      await vi.advanceTimersByTimeAsync(3100)
      await p
      expect(only(table)).toMatchObject({ outcome: 'n8n_response', n8n_status: 200, response_status: 200 })
    } finally { vi.useRealTimers() }
  })

  it('a PATCH that throws alerts; the response is unchanged', async () => {
    const { handler, calls } = load({ upstream: ok, trace: { updateThrows: true } })
    const res = await handler(event())
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(slackPosts(calls)[0].opts.body).text).toContain('error=TypeError')
  })

  for (const slack of ['rejects', 'throws']) {
    it('Slack ' + slack + ': the call still completes with the same response and a log line', async () => {
      const { handler, logs } = load({ upstream: ok, trace: { insertStatus: 500 }, slack })
      const res = await handler(event())
      expect(res.statusCode).toBe(200)
      expect(logs.some((l) => l.text.includes('generate_trace_write_failed'))).toBe(true)
      expect(logs.some((l) => l.text.includes('trace alert'))).toBe(true)
    })
  }

  it('alerts are throttled across calls in one warm container; each failure is still logged', async () => {
    const { handler, calls, logs } = load({ upstream: ok, trace: { insertStatus: 500 } })
    await handler(event())
    await handler(event())
    await handler(event())
    expect(slackPosts(calls)).toHaveLength(1)
    const failures = logs.filter((l) => l.text.includes('generate_trace_write_failed')).map((l) => JSON.parse(l.text))
    expect(failures).toHaveLength(3)
    expect(failures.filter((f) => f.slack === 'throttled')).toHaveLength(2)
  })

  it('an unexpected throw still closes the row with response 500', async () => {
    const { handler, table } = load({ upstream: ok })
    const ev = event()
    ev.headers = null // handle() reads event.headers.authorization and throws
    const res = await handler(ev)
    expect(res.statusCode).toBe(500)
    expect(only(table)).toMatchObject({ outcome: null, response_status: 500 })
    expect(typeof only(table).completed_at).toBe('string')
  })

  it('the fake enforces the CHECKs it mirrors', () => {
    expect(violates({ outcome: 'refused', refusal_reason: 'x', forwarded_at: 'now' })).toBe('refused_not_forwarded')
    expect(violates({ outcome: 'n8n_network_error', n8n_status: 403 })).toBe('n8n_status_iff_response')
    expect(violates({ outcome: 'n8n_response', n8n_status: 200 })).toBeNull()
  })
})

describe('C5 ruling (Mac 2026-10-06): no untrusted ids in the table', () => {
  it('the entry insert carries no ids at all', async () => {
    const { handler, calls } = load({ upstream: ok })
    await handler(event())
    const insert = calls.find((c) => c.url.includes('generate_proxy_calls') && c.opts.method === 'POST')
    expect(Object.keys(JSON.parse(insert.opts.body)).sort()).toEqual(['id', 'platform_count'])
  })

  it('the checkpoint before n8n carries the verified ids and forwarded_at', async () => {
    const { handler, snapshots } = load({ upstream: ok })
    await handler(event())
    const cp = snapshots.find((x) => x.stage === 'checkpoint').row
    expect(cp).toMatchObject({ studio_id: STUDIO, client_request_id: REQ, slot_id: SLOT, auth_user_id: USER, caller_role: 'studio_owner' })
    expect(typeof cp.forwarded_at).toBe('string')
  })

  it('a slot of ANOTHER studio is not stored (the call still runs)', async () => {
    const { handler, table, calls } = load({ upstream: ok })
    const res = await handler(event({ slot_id: FOREIGN_SLOT }))
    expect(res.statusCode).toBe(200)
    expect(calls.some((c) => c.url === WEBHOOK)).toBe(true)
    expect(only(table)).toMatchObject({ studio_id: STUDIO, slot_id: null })
  })

  it('an instructor cannot read slots under RLS, so their slot_id stays null', async () => {
    const { handler, table } = load({ upstream: ok, who: 'teacher@example.test', instructors: [{ instructor_email: 'teacher@example.test' }] })
    await handler(event())
    expect(only(table)).toMatchObject({ caller_role: 'studio_instructor', studio_id: STUDIO, slot_id: null })
  })

  it('a slot read failure is "not verified", never a refusal', async () => {
    const { handler, table } = load({ upstream: ok, slots: null })
    const res = await handler(event())
    expect(res.statusCode).toBe(200)
    expect(only(table).slot_id).toBeNull()
  })

  it('regenerate_of is stored only after the gate passes; a refused regenerate stores none', async () => {
    const ROW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const { handler, table } = load({ upstream: ok })
    await handler(event({ regenerate_of: ROW }))
    expect(only(table)).toMatchObject({ refusal_reason: 'regenerate_not_visible', regenerate_of: null, studio_id: STUDIO })
  })

  it('a client_id that fails its check is not stored', async () => {
    const ROW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const { handler, table } = load({ upstream: ok, clients: [{ id: ROW, studio_id: STUDIO, email: 'someone@example.test' }] })
    await handler(event({ client_id: ROW }))
    expect(only(table)).toMatchObject({ refusal_reason: 'client_not_caller', client_id: null, studio_id: null })
  })
})

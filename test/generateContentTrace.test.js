import { describe, it, expect } from 'vitest'
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

function load({ upstream, trace = {}, env: envExtra = {}, owner = 'owner@example.test' } = {}) {
  const calls = []
  const logs = []
  const table = new Map()
  const order = []
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    if (url.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: USER, email: owner }) }
    if (url.includes('/rest/v1/generate_proxy_calls')) {
      expect(opts.headers.Authorization).toBe('Bearer ' + SERVICE)
      const row = JSON.parse(opts.body)
      for (const k of Object.keys(row)) if (!COLUMNS.has(k)) throw new Error('unknown column ' + k)
      if (opts.method === 'POST') {
        // Logged when the insert COMMITS (after the delay), so the order assertion measures
        // "row exists before n8n", not merely "insert was started before n8n".
        if (trace.insertDelay) await new Promise((r) => setTimeout(r, trace.insertDelay))
        order.push('insert')
        if (trace.insertThrows) throw new TypeError('fetch failed')
        if (trace.insertStatus) return { ok: false, status: trace.insertStatus, headers: new Map() }
        table.set(row.id, { ...row })
        return { ok: true, status: 201, headers: new Map() }
      }
      if (opts.method === 'PATCH') {
        order.push('update')
        if (trace.updateStatus) return { ok: false, status: trace.updateStatus, headers: new Map() }
        const id = param(url, 'id')
        const hit = trace.updateMisses ? null : table.get(id)
        if (hit) Object.assign(hit, row)
        return { ok: true, status: 204, headers: new Map([['content-range', '*/' + (hit ? 1 : 0)]]) }
      }
    }
    if (url.includes('/rest/v1/studio_accounts')) {
      return { ok: true, json: async () => [{ id: STUDIO, owner_email: owner }].filter((s) => s.id === param(url, 'id')) }
    }
    if (url.includes('/rest/v1/studio_instructors')) return { ok: true, json: async () => [] }
    if (url === WEBHOOK) { order.push('n8n'); return upstream(opts) }
    if (url === SLACK) return { ok: true, status: 200 }
    throw new Error('unexpected url ' + url)
  }
  const env = {
    N8N_WEBHOOK_URL: WEBHOOK, SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: 'anon',
    N8N_GENERATOR_KEY: KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SLACK_WEBHOOK_URL: SLACK, ...envExtra,
  }
  for (const k of Object.keys(env)) if (env[k] == null) delete env[k]
  const record = (level) => (...a) => logs.push({ level, text: a.map(String).join(' ') })
  const sandbox = {
    exports: {}, process: { env }, fetch, AbortController, setTimeout, clearTimeout,
    console: { log: record('log'), warn: record('warn'), error: record('error') },
  }
  sandbox.crypto = globalThis.crypto
  vm.runInNewContext(SRC, sandbox)
  return { handler: sandbox.exports.handler, calls, logs, table, order }
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

  it('the 25s abort (the usual path) closes as n8n_timeout with response 202', async () => {
    const { handler, table } = load({ upstream: abort })
    const res = await handler(event())
    expect(res.statusCode).toBe(202)
    expect(only(table)).toMatchObject({ outcome: 'n8n_timeout', n8n_status: null, response_status: 202 })
  })

  it('the row exists BEFORE n8n is called, even when the insert is slow', async () => {
    const { handler, order } = load({ upstream: ok, trace: { insertDelay: 30 } })
    await handler(event())
    expect(order).toEqual(['insert', 'n8n', 'update'])
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
    expect(only(table)).toMatchObject({
      studio_id: OTHER, outcome: 'refused', refusal_reason: 'not_member', response_status: 403,
      caller_role: null, forwarded_at: null, n8n_status: null,
    })
  })

  it('no token: refused / no_token / 401, with the ids as sent', async () => {
    const { handler, table } = load({ upstream: ok })
    const res = await handler(event({}, {}))
    expect(res.statusCode).toBe(401)
    expect(only(table)).toMatchObject({ client_request_id: REQ, outcome: 'refused', refusal_reason: 'no_token', response_status: 401 })
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

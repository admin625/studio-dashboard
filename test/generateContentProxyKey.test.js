import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/**
 * AG-1.8, HQ 2026-09-28. The proxy sends X-FCA-Proxy-Key to the generator webhook, and
 * every upstream failure leaves one status-only `generate_upstream_error` line in the
 * function log. That log line is the 24h rollback watch's only signal.
 *
 * generate-content.js is CommonJS inside a "type":"module" package, so it is loaded in a
 * VM sandbox with a fake fetch, console and env, not imported.
 */
const SRC = readFileSync(new URL('../netlify/functions/generate-content.js', import.meta.url), 'utf8')
const WEBHOOK = 'https://n8n.example.test/webhook/fca-studio-agent'
const SUPA = 'https://supa.example.test'
// Deliberately low-entropy so the repo's pre-commit secret scan doesn't read it as a credential.
const KEY = 'unit-test-proxy-key-'.repeat(3)
// The modal always sends objects with an explicit postCount.
const IG = [{ name: 'instagram', postCount: 3, includeImages: true, formats: ['feed_post'] }]
const STUDIO = '11111111-2222-3333-4444-555555555555'

// What the caller's token can see under RLS. Defaults: owner@example.test owns STUDIO.
const DB = () => ({
  who: 'owner@example.test',
  studios: [{ id: STUDIO, owner_email: 'owner@example.test' }],
  instructors: [],   // studio_instructors rows visible to the caller; each carries its own status
  clients: [],       // clients rows visible to the caller
  fail: null,        // a table name whose lookup returns 500
  badJson: null,     // a table name whose json() rejects
})
const param = (url, name) => { const m = url.match(new RegExp('[?&]' + name + '=eq\\.([^&]+)')); return m ? decodeURIComponent(m[1]) : null }

function load({ key = KEY, upstream, db = DB() }) {
  const logs = []
  const calls = []
  const rows = (table, list) => {
    if (db.fail === table) return { ok: false, status: 500, json: async () => ({}) }
    if (db.badJson === table) return { ok: true, json: async () => { throw new SyntaxError('Unexpected token') } }
    return { ok: true, json: async () => list }
  }
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    if (url.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ email: db.who }) }
    if (url.includes('/rest/v1/studio_accounts')) return rows('studio_accounts', db.studios.filter((s) => s.id === param(url, 'id')))
    // Honours the status filter the way PostgREST would: no filter in the URL returns every status.
    if (url.includes('/rest/v1/studio_instructors')) {
      const st = param(url, 'status')
      return rows('studio_instructors', db.instructors.filter((s) => s.studio_id === param(url, 'studio_id') && (st == null || s.status === st)))
    }
    if (url.includes('/rest/v1/clients')) return rows('clients', db.clients.filter((c) => c.id === param(url, 'id')))
    if (url === WEBHOOK) return upstream(opts)
    throw new Error('unexpected url ' + url)
  }
  const env = { N8N_WEBHOOK_URL: WEBHOOK, SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: 'anon' }
  if (key) env.N8N_GENERATOR_KEY = key
  const record = (level) => (...a) => logs.push({ level, text: a.map(String).join(' ') })
  const sandbox = {
    exports: {}, process: { env }, fetch, AbortController, setTimeout, clearTimeout,
    console: { log: record('log'), warn: record('warn'), error: record('error') },
  }
  vm.runInNewContext(SRC, sandbox)
  return { handler: sandbox.exports.handler, logs, calls }
}

const event = () => ({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer user-jwt' },
  body: JSON.stringify({ email: 'owner@example.test', studio_id: STUDIO, platforms: IG }),
})
const ok = () => ({ ok: true, status: 200, text: async () => '{"success":true}' })
const status = (s) => () => ({ ok: false, status: s, text: async () => '{"message":"Authorization data is wrong!"}' })
const webhookCall = (calls) => calls.find((c) => c.url === WEBHOOK)
const tagged = (logs) => logs.filter((l) => l.text.includes('generate_upstream_error')).map((l) => JSON.parse(l.text))
const pending = (logs) => logs.filter((l) => l.text.includes('generate_upstream_pending')).map((l) => JSON.parse(l.text))

describe('AG-1.8 X-FCA-Proxy-Key header', () => {
  it('sends the header when N8N_GENERATOR_KEY is set, alongside Content-Type', async () => {
    const { handler, calls } = load({ upstream: ok })
    await handler(event())
    expect(webhookCall(calls).opts.headers).toEqual({ 'Content-Type': 'application/json', 'X-FCA-Proxy-Key': KEY })
  })

  it('omits the header (and warns) when the key is not set: previews/branch deploys', async () => {
    const { handler, calls, logs } = load({ key: null, upstream: ok })
    const res = await handler(event())
    expect(webhookCall(calls).opts.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(res.statusCode).toBe(200)
    expect(logs.some((l) => l.level === 'warn' && l.text.includes('N8N_GENERATOR_KEY not set'))).toBe(true)
  })
})

describe('AG-1.8(c) generate_upstream_error log', () => {
  it('a 403 from n8n logs exactly {tag, status:403} and still passes 403 through', async () => {
    const { handler, logs } = load({ upstream: status(403) })
    const res = await handler(event())
    expect(res.statusCode).toBe(403)
    expect(tagged(logs)).toEqual([{ tag: 'generate_upstream_error', status: 403 }])
  })

  it('a 401 and a 500 are tagged too (any non-2xx)', async () => {
    for (const s of [401, 500]) {
      const { handler, logs } = load({ upstream: status(s) })
      await handler(event())
      expect(tagged(logs)).toEqual([{ tag: 'generate_upstream_error', status: s }])
    }
  })

  // The proxy's OWN rejections must never look like an upstream one: a studio-mismatch 403 is
  // indistinguishable by status from the n8n auth 403 the rollback watch is looking for.
  it('its own studio-mismatch 403 emits no tag and never calls n8n', async () => {
    const { handler, logs, calls } = load({ upstream: ok })
    const ev = event()
    ev.body = JSON.stringify({ email: 'owner@example.test', studio_id: '99999999-2222-3333-4444-555555555555', platforms: IG })
    const res = await handler(ev)
    expect(res.statusCode).toBe(403)
    expect(webhookCall(calls)).toBeUndefined()
    expect(tagged(logs)).toEqual([])
  })

  it('its own missing-token 401 emits no tag and never calls n8n', async () => {
    const { handler, logs, calls } = load({ upstream: ok })
    const ev = event()
    ev.headers = {}
    const res = await handler(ev)
    expect(res.statusCode).toBe(401)
    expect(webhookCall(calls)).toBeUndefined()
    expect(tagged(logs)).toEqual([])
  })

  it('a 2xx logs nothing tagged', async () => {
    const { handler, logs } = load({ upstream: ok })
    await handler(event())
    expect(tagged(logs)).toEqual([])
  })

  // HQ 09-28: the 25s abort is the NORMAL path (runs take ~50-85s), so it has its own tag and
  // never appears as an upstream error.
  it('an abort (the 25s timeout) logs generate_upstream_pending, no error tag, still 202', async () => {
    const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    const { handler, logs } = load({ upstream: abort })
    const res = await handler(event())
    expect(res.statusCode).toBe(202)
    expect(pending(logs)).toEqual([{ tag: 'generate_upstream_pending' }])
    expect(tagged(logs)).toEqual([])
  })

  it('a network error logs kind "network" and returns 502 without err.message in the body', async () => {
    const boom = () => { throw new TypeError('fetch failed: https://secret-webhook.example.test/x') }
    const { handler, logs } = load({ upstream: boom })
    const res = await handler(event())
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toEqual({ error: 'Upstream request failed' })
    expect(tagged(logs)).toEqual([{ tag: 'generate_upstream_error', kind: 'network' }])
  })

  it('refuses to follow redirects (the header must never reach another host)', async () => {
    const { handler, calls } = load({ upstream: ok })
    await handler(event())
    expect(webhookCall(calls).opts.redirect).toBe('error')
  })

  it('a body-read failure after a non-2xx is logged once, with its status', async () => {
    const up = () => ({ ok: false, status: 403, text: async () => { throw new TypeError('terminated') } })
    const { handler, logs } = load({ upstream: up })
    await handler(event())
    expect(tagged(logs)).toEqual([{ tag: 'generate_upstream_error', status: 403 }])
  })

  it('a malformed key (embedded line break) is not sent, and is logged by name only', async () => {
    const bad = 'unit-test-proxy-key-\nsecond-line'
    const { handler, calls, logs } = load({ key: bad, upstream: ok })
    await handler(event())
    expect(webhookCall(calls).opts.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(logs.some((l) => l.text.includes('N8N_GENERATOR_KEY is malformed'))).toBe(true)
    expect(logs.some((l) => l.text.includes('second-line'))).toBe(false)
  })

  it('the key value never appears in any log line, on any path', async () => {
    const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    const boom = () => { throw new TypeError('fetch failed') }
    for (const upstream of [ok, status(403), abort, boom]) {
      const { handler, logs } = load({ upstream })
      await handler(event())
      expect(logs.some((l) => l.text.includes(KEY) || l.text.includes(KEY.slice(10, 30)))).toBe(false)
    }
  })
})

/**
 * HQ 2026-09-29: identity is derived server-side. Before this, the proxy forwarded body.email and
 * body.user_role as sent. `user_role: "studio_instructor"` skipped the generator's paywall on a
 * canceled studio (exec 73742), and body.email pointed the delivery, the success email and the
 * posts_used write at another tenant (exec 73744 overwrote T2's counter 1 -> 2).
 */
const OTHER = '99999999-8888-7777-6666-555555555555'
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const send = async (body, db = DB()) => {
  const { handler, calls, logs } = load({ upstream: ok, db })
  const ev = event()
  ev.body = JSON.stringify(body)
  const res = await handler(ev)
  const hook = webhookCall(calls)
  return { res, calls, logs, forwarded: hook ? JSON.parse(hook.opts.body) : null }
}
const base = (extra = {}) => ({ studio_id: STUDIO, platforms: IG, ...extra })

describe('HQ 09-29 identity derivation', () => {
  const HEX = 'abcdef12-3456-4789-abcd-ef1234567890'      // hex letters: toUpperCase changes it
  const HEXC = 'fedcba98-7654-4321-8abc-def012345678'
  const teacher = (db, extra = {}) => {
    db.who = 'teacher@example.test'
    db.instructors = [{ studio_id: STUDIO, instructor_email: 'teacher@example.test', status: 'active', ...extra }]
    return db
  }

  it('a forged user_role is dropped: the owner is forwarded as studio_owner', async () => {
    const { res, forwarded } = await send(base({ user_role: 'studio_instructor' }))
    expect(res.statusCode).toBe(200)
    expect(forwarded.user_role).toBe('studio_owner')
  })

  it('a forged email is dropped: the verified session email is forwarded', async () => {
    const { forwarded } = await send(base({ email: 'victim@other-tenant.test' }))
    expect(forwarded.email).toBe('owner@example.test')
  })

  it('the verified email is forwarded as GoTrue returned it, not lowercased', async () => {
    const db = DB(); db.who = 'Owner@Example.test'
    const { forwarded } = await send(base(), db)
    expect(forwarded.email).toBe('Owner@Example.test')
    expect(forwarded.user_role).toBe('studio_owner')
  })

  it('owner_email is compared case-insensitively', async () => {
    const db = DB(); db.studios = [{ id: STUDIO, owner_email: 'OWNER@example.test' }]
    const { res, forwarded } = await send(base(), db)
    expect(res.statusCode).toBe(200)
    expect(forwarded.user_role).toBe('studio_owner')
  })

  it('an ACTIVE instructor of the studio is forwarded as studio_instructor with their own email', async () => {
    const { res, forwarded } = await send(base({ user_role: 'studio_owner', email: 'owner@example.test' }), teacher(DB()))
    expect(res.statusCode).toBe(200)
    expect(forwarded.user_role).toBe('studio_instructor')
    expect(forwarded.email).toBe('teacher@example.test')
  })

  it('instructor_email is compared case-insensitively', async () => {
    const { res, forwarded } = await send(base(), teacher(DB(), { instructor_email: 'Teacher@Example.test' }))
    expect(res.statusCode).toBe(200)
    expect(forwarded.user_role).toBe('studio_instructor')
  })

  // The lookup must filter on status=active. The fake honours that filter, so dropping it from
  // the URL makes this inactive row visible and the test fails.
  it('an INACTIVE instructor row is not membership: 403, never reaches n8n', async () => {
    const { res, calls } = await send(base(), teacher(DB(), { status: 'inactive' }))
    expect(res.statusCode).toBe(403)
    expect(webhookCall(calls)).toBeUndefined()
  })

  it('an active instructor row without a visible studio row is still 403', async () => {
    const db = teacher(DB()); db.studios = []
    const { res, calls } = await send(base(), db)
    expect(res.statusCode).toBe(403)
    expect(webhookCall(calls)).toBeUndefined()
  })

  // A former instructor keeps a clients row, and get_my_studio_ids() still lets them see the
  // studio. Seeing the studio is not membership: no owner match, no active row, so 403.
  it('a caller who can see the studio but is neither owner nor active instructor gets 403', async () => {
    const db = DB(); db.who = 'former@example.test'
    db.clients = [{ id: CLIENT, studio_id: STUDIO, email: 'former@example.test' }]
    const { res, calls } = await send(base({ user_role: 'studio_instructor', client_id: CLIENT }), db)
    expect(res.statusCode).toBe(403)
    expect(webhookCall(calls)).toBeUndefined()
  })

  it('a studio the caller cannot see gets 403 and never reaches n8n', async () => {
    const { res, calls } = await send(base({ studio_id: OTHER }))
    expect(res.statusCode).toBe(403)
    expect(webhookCall(calls)).toBeUndefined()
  })

  it('studio_id is required: a client_id-only request gets 400', async () => {
    const { res, calls } = await send({ client_id: CLIENT, platforms: IG })
    expect(res.statusCode).toBe(400)
    expect(webhookCall(calls)).toBeUndefined()
  })

  it('a malformed studio_id gets 400 before any lookup', async () => {
    const { res, calls } = await send(base({ studio_id: STUDIO + ',id.neq.x' }))
    expect(res.statusCode).toBe(400)
    expect(calls.some((c) => c.url.includes('/rest/v1/'))).toBe(false)
  })

  it('a malformed client_id gets 400 before any lookup', async () => {
    const { res, calls } = await send(base({ client_id: CLIENT + ',id.neq.x' }))
    expect(res.statusCode).toBe(400)
    expect(calls.some((c) => c.url.includes('/rest/v1/'))).toBe(false)
  })

  it('an uppercase studio_id is normalized, not refused', async () => {
    const db = DB(); db.studios = [{ id: HEX, owner_email: 'owner@example.test' }]
    expect(HEX.toUpperCase()).not.toBe(HEX)
    const { res, forwarded } = await send(base({ studio_id: HEX.toUpperCase() }), db)
    expect(res.statusCode).toBe(200)
    expect(forwarded.studio_id).toBe(HEX)
  })

  it('an uppercase client_id is normalized, not refused', async () => {
    const db = DB(); db.clients = [{ id: HEXC, studio_id: STUDIO, email: 'owner@example.test' }]
    const { res, forwarded } = await send(base({ client_id: HEXC.toUpperCase() }), db)
    expect(res.statusCode).toBe(200)
    expect(forwarded.client_id).toBe(HEXC)
  })

  it("the caller's own client_id under the studio is accepted", async () => {
    const db = DB(); db.clients = [{ id: CLIENT, studio_id: STUDIO, email: 'owner@example.test' }]
    const { res, forwarded } = await send(base({ client_id: CLIENT, email: 'victim@other-tenant.test' }), db)
    expect(res.statusCode).toBe(200)
    expect(forwarded.email).toBe('owner@example.test')
    expect(forwarded.client_id).toBe(CLIENT)
  })

  it('a client_id under another studio gets 400', async () => {
    const db = DB(); db.clients = [{ id: CLIENT, studio_id: OTHER, email: 'owner@example.test' }]
    const { res, calls } = await send(base({ client_id: CLIENT }), db)
    expect(res.statusCode).toBe(400)
    expect(webhookCall(calls)).toBeUndefined()
  })

  it('a client_id the caller cannot see gets 400', async () => {
    const { res, calls } = await send(base({ client_id: CLIENT }))
    expect(res.statusCode).toBe(400)
    expect(webhookCall(calls)).toBeUndefined()
  })

  // Review 09-29: the generator keys the trial cap and posts_used on body.email. An owner naming an
  // instructor's row would move the cap onto that row's counter.
  it('an owner naming ANOTHER client in their studio gets 403 (cap subject cannot be moved)', async () => {
    const db = DB(); db.clients = [{ id: CLIENT, studio_id: STUDIO, email: 'teacher@example.test' }]
    const { res, calls } = await send(base({ client_id: CLIENT }), db)
    expect(res.statusCode).toBe(403)
    expect(webhookCall(calls)).toBeUndefined()
  })

  // An instructor's own clients row makes the studio's clients visible under RLS.
  it("an instructor naming the owner's client_id gets 403 (cannot send as the owner)", async () => {
    const db = teacher(DB()); db.clients = [{ id: CLIENT, studio_id: STUDIO, email: 'owner@example.test' }]
    const { res, calls } = await send(base({ client_id: CLIENT }), db)
    expect(res.statusCode).toBe(403)
    expect(webhookCall(calls)).toBeUndefined()
  })

  it('a null or non-object JSON body gets 400, not a crash', async () => {
    for (const raw of ['null', '42', '"x"', '[]']) {
      const { handler, calls } = load({ upstream: ok })
      const ev = event(); ev.body = raw
      const res = await handler(ev)
      expect(res.statusCode).toBe(400)
      expect(webhookCall(calls)).toBeUndefined()
    }
  })

  it('a failed lookup (any of the three) is a 502 and never reaches n8n', async () => {
    for (const table of ['studio_accounts', 'studio_instructors', 'clients']) {
      const db = DB(); db.fail = table
      db.clients = [{ id: CLIENT, studio_id: STUDIO, email: 'owner@example.test' }]
      const { res, calls } = await send(base({ client_id: CLIENT }), db)
      expect(res.statusCode).toBe(502)
      expect(webhookCall(calls)).toBeUndefined()
    }
  })

  it('an unreadable lookup body is a 502 and never reaches n8n', async () => {
    const db = DB(); db.badJson = 'studio_accounts'
    const { res, calls } = await send(base(), db)
    expect(res.statusCode).toBe(502)
    expect(webhookCall(calls)).toBeUndefined()
  })

  it('without a client_id there is no clients lookup at all', async () => {
    const { calls } = await send(base())
    expect(calls.some((c) => c.url.includes('/rest/v1/clients'))).toBe(false)
  })

  it('every role lookup carries the caller token, never a service key', async () => {
    const db = DB(); db.clients = [{ id: CLIENT, studio_id: STUDIO, email: 'owner@example.test' }]
    const { calls } = await send(base({ client_id: CLIENT }), db)
    const lookups = calls.filter((c) => c.url.includes('/rest/v1/'))
    expect(lookups.length).toBe(3)
    for (const c of lookups) expect(c.opts.headers.Authorization).toBe('Bearer user-jwt')
  })
})

/**
 * HQ 2026-09-29 scope add: postCount is bounded to what GenerateModal can send (a 1-5 select on
 * each of 5 platforms, so 25 per request). The trial cap is checked before a run against posts
 * already used, so without this one request could ask for any number of posts.
 */
describe('HQ 09-29 postCount clamp', () => {
  const plat = (name, postCount) => ({ name, postCount, includeImages: false })
  const ALL5 = (n) => ['instagram', 'facebook', 'twitter', 'linkedin', 'tiktok'].map((p) => plat(p, n))

  it('the modal maximum passes: 5 platforms x 5 posts = 25', async () => {
    const { res, forwarded } = await send(base({ platforms: ALL5(5) }))
    expect(res.statusCode).toBe(200)
    expect(forwarded.platforms).toEqual(ALL5(5))
  })

  it('the modal minimum passes: one platform, 1 post', async () => {
    const { res } = await send(base({ platforms: [plat('instagram', 1)] }))
    expect(res.statusCode).toBe(200)
  })

  it('a total above 25 gets 400 and never reaches n8n, even when every entry is in range', async () => {
    const { res, calls } = await send(base({ platforms: [...ALL5(5), plat('instagram', 1)] }))
    expect(res.statusCode).toBe(400)
    expect(webhookCall(calls)).toBeUndefined()
  })

  it('a per-platform count above 5 gets 400', async () => {
    const { res, calls } = await send(base({ platforms: [plat('instagram', 6)] }))
    expect(res.statusCode).toBe(400)
    expect(webhookCall(calls)).toBeUndefined()
  })

  it('zero, negative, fractional, string and huge counts get 400', async () => {
    for (const n of [0, -1, 2.5, '3', 1e9, NaN, null]) {
      const { res, calls } = await send(base({ platforms: [plat('instagram', n)] }))
      expect(res.statusCode).toBe(400)
      expect(webhookCall(calls)).toBeUndefined()
    }
  })

  // The generator reads a missing postCount, or a bare string entry, as 3 posts each, so many of
  // them would add up without ever carrying a number the clamp could see.
  it('a missing postCount, a bare string entry, null or an array entry gets 400', async () => {
    for (const p of [{ name: 'instagram' }, 'instagram', null, ['instagram', 3]]) {
      const { res, calls } = await send(base({ platforms: [p] }))
      expect(res.statusCode).toBe(400)
      expect(webhookCall(calls)).toBeUndefined()
    }
  })

  it('the clamp runs before any lookup', async () => {
    const { calls } = await send(base({ platforms: [plat('instagram', 99)] }))
    expect(calls.some((c) => c.url.includes('/rest/v1/'))).toBe(false)
  })
})

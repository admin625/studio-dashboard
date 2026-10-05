import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/**
 * WO-4 N2 (HQ 2026-09-29) and V7's proxy half. generate-content.js accepts `regenerate_of` only
 * for an ORIGINAL, FLAGGED delivery of the named studio that has no regenerate yet. The generator
 * writes content_deliveries.regenerated_from straight from it, and the entitlement WO will read
 * that link to decide what is free, so this proxy is the only gate.
 *
 * Same VM-sandbox harness as generateContentProxyKey.test.js (CommonJS inside a "type":"module"
 * package). content_deliveries reads honour RLS the way PostgREST would: the caller sees only rows
 * of studios it belongs to, unless a test deliberately simulates a leak.
 */
const SRC = readFileSync(new URL('../netlify/functions/generate-content.js', import.meta.url), 'utf8')
const WEBHOOK = 'https://n8n.example.test/webhook/fca-studio-agent'
const SUPA = 'https://supa.example.test'
const IG = [{ name: 'instagram', postCount: 1, includeImages: false, formats: ['feed_post'] }]
const STUDIO = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'
const FLAGGED = 'aaaaaaaa-0000-4000-8000-000000000001'
const UNFLAGGED = 'aaaaaaaa-0000-4000-8000-000000000002'
const A_REGEN = 'aaaaaaaa-0000-4000-8000-000000000003'
const PRE_M3 = 'aaaaaaaa-0000-4000-8000-000000000004'
const FOREIGN = 'bbbbbbbb-0000-4000-8000-000000000001'

const DB = () => ({
  who: 'owner@example.test',
  studios: [{ id: STUDIO, owner_email: 'owner@example.test' }],
  deliveries: [
    { id: FLAGGED, studio_id: STUDIO, quality_flag: true, regenerated_from: null },
    { id: UNFLAGGED, studio_id: STUDIO, quality_flag: false, regenerated_from: null },
    { id: A_REGEN, studio_id: STUDIO, quality_flag: true, regenerated_from: UNFLAGGED },
    { id: PRE_M3, studio_id: STUDIO, quality_flag: null, regenerated_from: null },
    { id: FOREIGN, studio_id: OTHER, quality_flag: true, regenerated_from: null },
  ],
  rlsLeak: false,   // true: the caller can see other studios' rows (simulates a broken policy)
  failDeliveries: false,
})
const param = (url, name) => { const m = url.match(new RegExp('[?&]' + name + '=eq\\.([^&]+)')); return m ? decodeURIComponent(m[1]) : null }

function load(db = DB()) {
  const calls = []
  const logs = []
  const visible = () => db.deliveries.filter((d) => db.rlsLeak || db.studios.some((s) => s.id === d.studio_id && s.owner_email === db.who))
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    if (url.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ email: db.who }) }
    if (url.includes('/rest/v1/studio_accounts')) return { ok: true, json: async () => db.studios.filter((s) => s.id === param(url, 'id')) }
    if (url.includes('/rest/v1/studio_instructors')) return { ok: true, json: async () => [] }
    if (url.includes('/rest/v1/content_deliveries')) {
      if (db.failDeliveries) return { ok: false, status: 500, json: async () => ({}) }
      const byId = param(url, 'id')
      const byFrom = param(url, 'regenerated_from')
      const rows = visible().filter((d) => (byId ? d.id === byId : true) && (byFrom ? d.regenerated_from === byFrom : true))
      // Columns: only what was selected, so a test can see nothing heavy is read.
      const sel = (url.match(/select=([^&]+)/) || [])[1].split(',')
      return { ok: true, json: async () => rows.map((r) => Object.fromEntries(sel.map((c) => [c, r[c]]))) }
    }
    if (url === WEBHOOK) return { ok: true, status: 200, text: async () => '{"success":true}' }
    throw new Error('unexpected url ' + url)
  }
  const record = (level) => (...a) => logs.push({ level, text: a.map(String).join(' ') })
  const sandbox = {
    exports: {}, process: { env: { N8N_WEBHOOK_URL: WEBHOOK, SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: 'anon', N8N_GENERATOR_KEY: 'unit-test-key' } },
    fetch, AbortController, setTimeout, clearTimeout,
    console: { log: record('log'), warn: record('warn'), error: record('error') },
  }
  vm.runInNewContext(SRC, sandbox)
  return { handler: sandbox.exports.handler, calls, logs, db }
}

const event = (extra = {}) => ({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer user-jwt' },
  body: JSON.stringify({ studio_id: STUDIO, platforms: IG, ...extra }),
})
const webhookBody = (calls) => { const c = calls.find((x) => x.url === WEBHOOK); return c ? JSON.parse(c.opts.body) : null }
const deliveryReads = (calls) => calls.filter((c) => c.url.includes('/rest/v1/content_deliveries'))
const errorOf = (res) => JSON.parse(res.body).error

describe('regenerate_of: accepted only for a flagged original of this studio, once (N2)', () => {
  it('a flagged original of the named studio is accepted and forwarded, lowercased', async () => {
    const { handler, calls } = load()
    const res = await handler(event({ regenerate_of: FLAGGED.toUpperCase() }))
    expect(res.statusCode).toBe(200)
    expect(webhookBody(calls).regenerate_of).toBe(FLAGGED)
  })

  it('the lookups read ids and flags only, never content', async () => {
    const { handler, calls } = load()
    await handler(event({ regenerate_of: FLAGGED }))
    const reads = deliveryReads(calls)
    expect(reads).toHaveLength(2)
    for (const r of reads) expect(r.url).not.toMatch(/_content|\*/)
    // ...and with the caller's token, never a service key.
    for (const r of reads) expect(r.opts.headers.Authorization).toBe('Bearer user-jwt')
  })

  it("REFUSED: another studio's delivery (invisible under RLS) is a 403, before any generation", async () => {
    const { handler, calls } = load()
    const res = await handler(event({ regenerate_of: FOREIGN }))
    expect(res.statusCode).toBe(403)
    expect(webhookBody(calls)).toBeNull()
  })

  it("REFUSED: another studio's delivery even if RLS leaked it (the studio_id is compared too)", async () => {
    const db = DB(); db.rlsLeak = true
    const { handler, calls } = load(db)
    const res = await handler(event({ regenerate_of: FOREIGN }))
    expect(res.statusCode).toBe(403)
    expect(webhookBody(calls)).toBeNull()
  })

  it('REFUSED: an unflagged delivery (409)', async () => {
    const { handler, calls } = load()
    const res = await handler(event({ regenerate_of: UNFLAGGED }))
    expect(res.statusCode).toBe(409)
    expect(errorOf(res)).toMatch(/Check before posting/)
    expect(webhookBody(calls)).toBeNull()
  })

  it('REFUSED: a row from before the flag columns (quality_flag null) is not flagged', async () => {
    const { handler, calls } = load()
    const res = await handler(event({ regenerate_of: PRE_M3 }))
    expect(res.statusCode).toBe(409)
    expect(webhookBody(calls)).toBeNull()
  })

  it('REFUSED: a delivery that is itself a regenerate (409)', async () => {
    const { handler, calls } = load()
    const res = await handler(event({ regenerate_of: A_REGEN }))
    expect(res.statusCode).toBe(409)
    expect(errorOf(res)).toMatch(/already a regenerate/)
    expect(webhookBody(calls)).toBeNull()
  })

  it('REFUSED: a second regenerate of the same original, once the first one has landed', async () => {
    const { handler, calls, db } = load()
    expect((await handler(event({ regenerate_of: FLAGGED }))).statusCode).toBe(200)
    db.deliveries.push({ id: 'aaaaaaaa-0000-4000-8000-0000000000ff', studio_id: STUDIO, quality_flag: false, regenerated_from: FLAGGED })
    const before = calls.filter((c) => c.url === WEBHOOK).length
    const res = await handler(event({ regenerate_of: FLAGGED }))
    expect(res.statusCode).toBe(409)
    expect(errorOf(res)).toMatch(/already been regenerated/)
    expect(calls.filter((c) => c.url === WEBHOOK).length).toBe(before)
  })

  it('REFUSED: a malformed regenerate_of (not a uuid, or not a string) is a 400', async () => {
    for (const bad of ['not-a-uuid', 42, { id: FLAGGED }, [FLAGGED], '']) {
      const { handler, calls } = load()
      const res = await handler(event({ regenerate_of: bad }))
      expect(res.statusCode).toBe(400)
      expect(webhookBody(calls)).toBeNull()
    }
  })

  it('a lookup failure is a 502 and nothing is generated (never fail-open)', async () => {
    const db = DB(); db.failDeliveries = true
    const { handler, calls } = load(db)
    const res = await handler(event({ regenerate_of: FLAGGED }))
    expect(res.statusCode).toBe(502)
    expect(webhookBody(calls)).toBeNull()
  })

  it('membership is checked first: a non-member gets the studio 403 and no delivery is read', async () => {
    const db = DB(); db.who = 'stranger@example.test'
    const { handler, calls } = load(db)
    const res = await handler(event({ regenerate_of: FLAGGED }))
    expect(res.statusCode).toBe(403)
    expect(deliveryReads(calls)).toHaveLength(0)
  })
})

describe('clients never set the lineage', () => {
  it('a client-sent regenerated_from is dropped (no regenerate_of)', async () => {
    const { handler, calls } = load()
    await handler(event({ regenerated_from: FLAGGED }))
    expect(webhookBody(calls)).not.toHaveProperty('regenerated_from')
    expect(webhookBody(calls)).not.toHaveProperty('regenerate_of')
  })

  it('a client-sent regenerated_from is dropped alongside a valid regenerate_of', async () => {
    const { handler, calls } = load()
    await handler(event({ regenerate_of: FLAGGED, regenerated_from: FOREIGN }))
    expect(webhookBody(calls).regenerate_of).toBe(FLAGGED)
    expect(webhookBody(calls)).not.toHaveProperty('regenerated_from')
  })

  it('negative control: an ordinary run reads no deliveries and forwards no regenerate_of (even an explicit null)', async () => {
    const { handler, calls } = load()
    const res = await handler(event({ regenerate_of: null }))
    expect(res.statusCode).toBe(200)
    expect(deliveryReads(calls)).toHaveLength(0)
    expect(webhookBody(calls)).not.toHaveProperty('regenerate_of')
  })
})

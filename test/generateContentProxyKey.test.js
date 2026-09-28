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
const STUDIO = '11111111-2222-3333-4444-555555555555'

function load({ key = KEY, upstream }) {
  const logs = []
  const calls = []
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    if (url.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'owner@example.test' }) }
    if (url.includes('/rest/v1/clients')) return { ok: true, json: async () => [{ studio_id: STUDIO }] }
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
  body: JSON.stringify({ email: 'owner@example.test', studio_id: STUDIO, platforms: ['instagram'] }),
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
    ev.body = JSON.stringify({ email: 'owner@example.test', studio_id: '99999999-2222-3333-4444-555555555555', platforms: ['instagram'] })
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

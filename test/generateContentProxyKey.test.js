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

describe('AG-1.8 X-FCA-Proxy-Key header', () => {
  it('sends the header when N8N_GENERATOR_KEY is set', async () => {
    const { handler, calls } = load({ upstream: ok })
    await handler(event())
    expect(webhookCall(calls).opts.headers['X-FCA-Proxy-Key']).toBe(KEY)
  })

  it('omits the header (and warns) when the key is not set: previews/branch deploys', async () => {
    const { handler, calls, logs } = load({ key: null, upstream: ok })
    const res = await handler(event())
    expect('X-FCA-Proxy-Key' in webhookCall(calls).opts.headers).toBe(false)
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

  it('a 2xx logs nothing tagged', async () => {
    const { handler, logs } = load({ upstream: ok })
    await handler(event())
    expect(tagged(logs)).toEqual([])
  })

  it('an abort (the 25s timeout) logs status "timeout" and still returns 202', async () => {
    const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    const { handler, logs } = load({ upstream: abort })
    const res = await handler(event())
    expect(res.statusCode).toBe(202)
    expect(tagged(logs)).toEqual([{ tag: 'generate_upstream_error', status: 'timeout' }])
  })

  it('a network error logs status "network" and returns 502', async () => {
    const boom = () => { throw new TypeError('fetch failed') }
    const { handler, logs } = load({ upstream: boom })
    const res = await handler(event())
    expect(res.statusCode).toBe(502)
    expect(tagged(logs)).toEqual([{ tag: 'generate_upstream_error', status: 'network' }])
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

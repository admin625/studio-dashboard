/**
 * reel-telemetry — unauthenticated ingest of last-resort for upload_events.
 *
 * WHY IT EXISTS. The browser writes upload_events directly as `authenticated`, and the
 * INSERT policy needs a live session. That means the single most interesting failure class —
 * "the upload broke BECAUSE the session died" — could never record itself. The client also
 * cannot complete an async insert during page unload, so abandonment was equally invisible.
 * Both now arrive here by navigator.sendBeacon.
 *
 * WHY NO AUTH. Requiring a token would reintroduce the exact dependency this path exists to
 * escape. The trade is deliberate and the blast radius is bounded by what the function will
 * accept: it writes to ONE table, it allows ONE column set, it forces `source`, and every
 * field is type- and vocabulary-checked before it reaches PostgREST. An attacker can insert
 * noise rows into a telemetry table. They cannot reach another table, another schema, or any
 * column that carries meaning elsewhere.
 *
 * ⚠️ RATE LIMITING IS EFFECTIVELY ABSENT, and that is reported rather than pretended.
 * Netlify offers no built-in per-IP limit for classic (non-edge) functions on this plan.
 * The counter below is per warm container: Netlify runs many concurrent instances and
 * recycles them freely, so a distributed or simply lucky caller bypasses it entirely. It
 * stops an accidental client-side retry storm from one browser. It is NOT a security
 * control and must not be described as one. A real limit needs an Edge Function or a
 * shared store, and is out of 2b scope.
 *
 * .js not .cjs is correct here ONLY because this file requires no local module. Add a
 * `require('./_anything.cjs')` and it must be renamed, or esbuild bundles it as ESM and
 * exports.handler stops registering -> Runtime.HandlerNotFound (reels, ~2h, 2026-08-06).
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fidhmvuurygpknhshpml.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_BODY_BYTES = 8 * 1024;
const MAX_ROWS = 25;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;

const STAGES = new Set([
  'file_selected', 'session_checked', 'transmit_started', 'transmit_completed',
  'transmit_abandoned', 'create_request_sent', 'storage_object_verified', 'wf1_triggered',
]);
const OUTCOMES = new Set(['ok', 'fail']);

// The ONLY columns a beaconed row may set. `source` is deliberately absent — it is forced
// below, never accepted. id, created_at and auth_user_id are server-owned. file_name,
// bytes_sent and error are the legacy trio that new code does not write.
const ALLOWED = {
  attempt_id: 'uuid', reel_id: 'uuid', studio_id: 'uuid',
  event_type: 'string', stage: 'string', outcome: 'string',
  occurred_at: 'string', clip_index: 'int', clip_count: 'int',
  file_size_bytes: 'int', mime_type: 'string', elapsed_ms: 'int',
  user_agent: 'string', storage_bucket: 'string', storage_path: 'string',
  observed_bytes: 'int', http_status: 'int',
  error_code: 'string', error_message: 'string', payload: 'object',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const respond = (statusCode, body) => ({
  statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) { hits.set(ip, { start: now, n: 1 }); return false; }
  rec.n += 1;
  if (hits.size > 5000) hits.clear(); // unbounded map in a warm container is a leak
  return rec.n > RATE_MAX;
}

/**
 * Validate one row. Returns { row } or { reject }.
 * Unknown keys are a REJECTION, not a silent drop: a client sending a field this function
 * quietly discards would look instrumented and record nothing, which is the defect the whole
 * telemetry effort exists to remove.
 */
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { reject: 'not_an_object' };

  const unknown = Object.keys(input).filter((k) => !(k in ALLOWED));
  if (unknown.length) return { reject: 'unknown_keys:' + unknown.slice(0, 5).join(',') };

  const row = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) continue;
    const t = ALLOWED[k];
    if (t === 'uuid') {
      if (typeof v !== 'string' || !UUID_RE.test(v)) return { reject: `bad_uuid:${k}` };
      row[k] = v;
    } else if (t === 'int') {
      if (!Number.isFinite(Number(v))) return { reject: `bad_int:${k}` };
      row[k] = Math.trunc(Number(v));
    } else if (t === 'string') {
      if (typeof v !== 'string') return { reject: `bad_string:${k}` };
      row[k] = v.slice(0, 2000);
    } else if (t === 'object') {
      if (typeof v !== 'object' || Array.isArray(v)) return { reject: `bad_object:${k}` };
      row[k] = v;
    }
  }

  if (!row.attempt_id) return { reject: 'attempt_id_required' };
  if (!STAGES.has(row.stage)) return { reject: 'bad_stage' };
  if (!OUTCOMES.has(row.outcome)) return { reject: 'bad_outcome' };
  // event_type is CHECK-constrained in the database. Derive it rather than trust it, so a
  // malformed client cannot produce a row whose event_type disagrees with its own stage.
  row.event_type = `${row.stage}_${row.outcome}`;
  if (row.occurred_at && !ISO_RE.test(row.occurred_at)) return { reject: 'bad_occurred_at' };
  if (!row.occurred_at) row.occurred_at = new Date().toISOString();
  if (!row.payload) row.payload = {};

  // Forced server-side. A beaconed row is still a client observation; letting the caller
  // label its own origin would make the emitter column unusable for exactly the question it
  // exists to answer.
  row.source = 'client';
  return { row };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'method not allowed' });
  if (!SERVICE_KEY) {
    console.error('[reel-telemetry] missing env: SUPABASE_SERVICE_ROLE_KEY');
    // 204, not 500: this is a beacon target. A misconfigured ingest must never surface to
    // the customer, and sendBeacon ignores the body anyway.
    return respond(204, {});
  }

  const ip = event.headers['x-nf-client-connection-ip']
    || (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || 'unknown';
  if (rateLimited(ip)) {
    console.warn('[reel-telemetry] per-instance rate limit hit');
    return respond(429, { error: 'rate limited' });
  }

  const raw = event.body || '';
  const size = Buffer.byteLength(raw, event.isBase64Encoded ? 'base64' : 'utf8');
  if (size > MAX_BODY_BYTES) {
    console.warn('[reel-telemetry] body too large:', size);
    return respond(413, { error: 'payload too large' });
  }

  let body;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw);
  } catch { return respond(400, { error: 'invalid JSON' }); }

  const incoming = Array.isArray(body?.rows) ? body.rows : [body];
  if (!incoming.length) return respond(400, { error: 'no rows' });
  if (incoming.length > MAX_ROWS) return respond(413, { error: 'too many rows' });

  const rows = [];
  const rejected = [];
  for (const r of incoming) {
    const { row, reject } = validate(r);
    if (reject) rejected.push(reject); else rows.push(row);
  }
  // Rejections are LOGGED, never silent. A shape this function refuses is a bug in the
  // emitter, and it has to be findable.
  if (rejected.length) console.warn('[reel-telemetry] rejected rows:', rejected.join(' | '));
  if (!rows.length) return respond(400, { error: 'no valid rows', rejected });

  try {
    // One table. No RPC, no dynamic path — the URL is a constant so a crafted payload
    // cannot redirect the write.
    const res = await fetch(SUPABASE_URL + '/rest/v1/upload_events', {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      // Status and a truncated body. PostgREST errors name the constraint, which is the
      // useful part; they do not echo credentials, but truncate regardless.
      const t = await res.text().catch(() => '');
      console.error('[reel-telemetry] insert failed:', res.status, t.slice(0, 300));
      return respond(502, { error: 'insert failed', status: res.status });
    }
    return respond(202, { accepted: rows.length, rejected: rejected.length });
  } catch (e) {
    console.error('[reel-telemetry] insert threw:', e.message);
    return respond(502, { error: 'insert threw' });
  }
};

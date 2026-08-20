// Slack relay for upload_failed telemetry.
//
// Why a function and not a direct call: SLACK_WEBHOOK_URL is a credential. Anything the
// browser can reach, the browser's bundle contains — putting the webhook in the client
// would hand an unauthenticated posting relay to anyone who opened devtools. The URL
// lives only in env here, so it is never in the repo or the bundle.
//
// Why Slack and not far_alerts: public.far_alerts has RLS enabled with zero policies and
// has never accepted a write. An unproven write path does not get a new consumer as its
// first test.
//
// This is a NOTIFICATION path. The durable record is the upload_events row, which the
// client writes first and independently. If this function is down, misconfigured, or slow,
// the row still exists. It must therefore never return an error the client treats as fatal.
//
// .cjs is REQUIRED here, not stylistic: this package is "type": "module", and a function
// that requires a local module (./_authz.cjs) gets bundled as ESM, at which point
// exports.handler stops registering -> Runtime.HandlerNotFound. That took reels down for
// ~2 hours on 2026-08-06.

const { requireStudioAccess } = require('./_authz.cjs');

const respond = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Slack parses control sequences inside `text`: <!channel>, <!here>, <@U123> all fire from
// free-text we did not author. file_name and error_message are attacker-influencable, so
// neutralise the delimiters rather than trusting their contents.
function slackSafe(v, max = 300) {
  if (v == null) return null;
  return String(v).replace(/[<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    console.error('[telemetry-alert] missing env: SLACK_WEBHOOK_URL');
    // 200, not 500: a missing alert channel must not surface to the customer as a second
    // failure stacked on the upload failure being reported.
    return respond(200, { alerted: false, reason: 'not_configured' });
  }

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return respond(400, { error: 'Invalid JSON' }); }

  // Authorize against the studio named in the body, not merely "some valid session".
  // Authenticating the caller proves who they are; it does not prove the alert they are
  // posting is theirs. Without this, any signed-in customer could raise an ops alert
  // attributed to another tenant. _authz.cjs is the pattern for exactly this.
  if (!b.studio_id) return respond(400, { error: 'studio_id is required' });
  const gate = await requireStudioAccess(event, b.studio_id, 'member');
  if (!gate.ok) return respond(gate.status, { error: gate.error });

  // `!= null`, not truthiness: a 0-byte clip is a plausible CAUSE of an upload failure and
  // must not be reported as "unknown size".
  const mb = b.file_size_bytes != null
    ? (Number(b.file_size_bytes) / 1024 / 1024).toFixed(1) + ' MB'
    : 'unknown size';
  const secs = b.elapsed_ms != null ? (Number(b.elapsed_ms) / 1000).toFixed(1) + 's' : 'unknown';

  // Tri-state, not a boolean. 'queued' will still land on the next emit; only 'dropped'
  // means the durable record is genuinely gone and this message is the sole trace. A flag
  // that fires on every alert is a flag the channel learns to ignore.
  const outcome = b.row_outcome;
  const rowNote = outcome === 'dropped'
    ? '  — :warning: telemetry row DROPPED, this alert is the only record'
    : outcome === 'queued'
      ? '  — :hourglass: telemetry row queued, not yet persisted'
      : '';

  const lines = [
    `:rotating_light: *Reel upload failed*${rowNote}`,
    `*Studio:* ${slackSafe(b.studio_id, 40) || 'unknown'}`,
    `*Stage:* ${slackSafe(b.stage, 40) || 'unknown'}`,
    `*File:* ${slackSafe(b.file_name, 120) || 'n/a'} (${mb}, ${slackSafe(b.mime_type, 40) || 'unknown type'})`,
    `*Elapsed:* ${secs}`,
    `*Error:* ${b.error_status ? '[' + slackSafe(b.error_status, 10) + '] ' : ''}${slackSafe(b.error_message, 400) || 'no message'}`,
    `*Attempt:* ${slackSafe(b.attempt_id, 40) || 'n/a'}${b.reel_id ? `  *Reel:* ${slackSafe(b.reel_id, 40)}` : ''}`,
  ];

  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
    });
    if (!r.ok) {
      // Status only. A webhook error body can echo the URL back.
      console.error('[telemetry-alert] slack rejected:', r.status);
      return respond(200, { alerted: false, reason: 'slack_' + r.status });
    }
    return respond(200, { alerted: true });
  } catch (e) {
    console.error('[telemetry-alert] slack post failed:', e.message);
    return respond(200, { alerted: false, reason: 'slack_unreachable' });
  }
};

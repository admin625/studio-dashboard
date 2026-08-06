/**
 * derive-photo-style — draft an ai_photo_prompt from a studio's own uploaded photos.
 *
 * WHY: ai_photo_prompt is the ONLY brand signal that can reach an AI-generated image. The AI
 * Photo workflow reads zero brand columns — colour, font, logo and voice cannot influence an
 * image at all. And no customer has ever filled the field: 4 of 6 live studios leave it blank,
 * including one whose photo_source is ai_assist, so she receives AI photos built from a generic
 * default prompt. The one populated entry was written by hand from the customer's website.
 *
 * "Describe your visual aesthetic" is a hard ask — owners recognise their aesthetic instantly
 * and cannot articulate it. This changes the ask to "does this sound right?", which is the
 * difference between a blank field and a filled one.
 *
 * NEVER WRITES. Returns a proposal; the owner reviews, edits, and saves explicitly via the
 * existing savePhotoPrompt(). Auto-population would put a plausible machine-written value in
 * the one field that is supposed to carry the studio's own identity — the same mistake as the
 * BRAND_VOICE_FALLBACK placeholder, which shipped a marketing cliche as 7 studios' brand voice.
 */
const { requireStudioAccess } = require('./_authz.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fidhmvuurygpknhshpml.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-sonnet-5';
const MAX_PHOTOS = 10;
const THIN_LIBRARY_BELOW = 3;   // warn, never block — see THIN below

// Target 25-50 words. The only ai_photo_prompt in the system that demonstrably produces
// studio-specific images is 27 words, comma-delimited, no sentences. Prose reads worse as a
// prefix: this text is prepended to an image prompt, so it must be direction, not commentary.
//
// Deliberately NO one-shot example. A concrete sample from a real studio teaches its CONTENT as
// well as its form — a black-and-white classical-Pilates example leaks monochrome and reformer
// apparatus into descriptions of warm colour photographs, and reads confident while being wrong.
// Structural constraints carry the register without carrying someone else's aesthetic.
const INSTRUCTION = [
  'You are shown up to 10 photographs from ONE fitness studio\'s own photo library.',
  '',
  'Write a short style directive describing how these photographs LOOK, so an image-generation',
  'model can produce new images that match. This text is prepended to image prompts, so write it',
  'as DIRECTION, not commentary.',
  '',
  'Describe only VISUAL properties you can see:',
  '  palette and colour grade - lighting (source, hardness, direction, time of day)',
  '  framing and composition - depth of field - setting, surfaces, materials',
  '  how people appear, if present (candid/posed, moving/static, close/wide)',
  '',
  'Hard rules:',
  '  - Describe ONLY what is visible. Never infer values, mission, personality, target audience',
  '    or price point. You cannot see those.',
  '  - Never invent detail. If something is not determinable, omit it.',
  '  - Do not name the studio, any place, any person, or any brand.',
  '  - Do not add production constraints (e.g. "no text overlay"). Those are set system-wide,',
  '    not derived from photographs.',
  '  - If the photographs are visually inconsistent, describe the DOMINANT pattern and note the',
  '    variation in one clause.',
  '  - Some images may be screenshots, exported graphics, posters or text-heavy promotional',
  '    tiles rather than photographs. IGNORE those entirely. Describe only the photographs.',
  '    If none of the images are photographs, reply with exactly: NO_PHOTOGRAPHS',
  '',
  'Form: comma-delimited visual attributes, dense, no sentences, no preamble, no heading.',
  '',
  'Output: 25-50 words, lower case. Start directly with the description.',
].join('\n');

const rest = (path) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
  headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  if (!SERVICE_KEY) return respond(500, { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' });
  if (!ANTHROPIC_API_KEY) {
    return respond(500, { error: 'ANTHROPIC_API_KEY is not configured. Set it in Netlify environment variables.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return respond(400, { error: 'Invalid JSON' }); }

  // Owner-level: this drafts a Brand Settings field, and Brand Settings is owner-only
  // everywhere else (sa_update_owner). Instructors are read-only on studio configuration.
  const gate = await requireStudioAccess(event, body.studio_id, 'owner');
  if (!gate.ok) return respond(gate.status, { error: gate.error });

  // source='uploaded' excludes ai_generated so the model cannot learn from its own output and
  // recycle generic imagery back into the prompt that produces it.
  // is_active IS TRUE respects the owner's own curation: archived means she removed it from the
  // library, so those are exactly the photos she does NOT want represented.
  // upload_date, not created_at — studio_photos has no created_at column.
  // Logos never appear here: they live in studio_accounts.logo_* and the logos/ storage path,
  // and are not studio_photos rows (verified: 0 logo rows in the table).
  let rows;
  try {
    const r = await rest('studio_photos?studio_id=eq.' + encodeURIComponent(body.studio_id) +
      '&source=eq.uploaded&is_active=is.true&select=photo_url,file_name,upload_date' +
      // Over-fetch: the screenshot filter runs client-side, so limiting to MAX_PHOTOS here
      // would hand a screenshot-heavy library a thin sample instead of reaching deeper.
      '&order=upload_date.desc&limit=' + (MAX_PHOTOS * 3));
    rows = await r.json();
    if (!Array.isArray(rows)) return respond(502, { error: 'studio_photos read failed' });
  } catch (err) {
    return respond(502, { error: 'Could not read the photo library.', detail: err.message });
  }

  // Stored photo_urls encode spaces (%20) but NOT '#'. Four of Katie's live rows are
  // Bike#1.jpg / Instructor#1.jpg, and a raw '#' is a fragment delimiter — any HTTP client
  // truncates there and fetches a 404. Encode it before handing the URL to a third party.
  const safeUrl = (u) => String(u).replace(/#/g, '%23');

  // Screenshots are not photographs. Her active library holds six "Screen Shot ..." PNGs, and
  // describing UI chrome as studio aesthetic is exactly the generic-output failure this is meant
  // to fix. Filename match only — high precision, nobody names a real photo "Screen Shot 2026-".
  // Designed graphics (Canva exports) are NOT caught here; the instruction handles those, since
  // the model can see what a filename cannot tell us.
  const IS_SCREENSHOT = /(^|[^a-z])screen[ _-]?shot|screenshot/i;

  const photos = rows
    .filter((p) => p && typeof p.photo_url === 'string' && /^https?:\/\//i.test(p.photo_url))
    .filter((p) => !IS_SCREENSHOT.test(p.file_name || ''))
    .map((p) => ({ ...p, fetch_url: safeUrl(p.photo_url) }))
    .slice(0, MAX_PHOTOS);
  if (photos.length === 0) {
    // Not an error: three live studios have an empty library and this is the honest answer.
    // The UI shows an upload nudge rather than a failure.
    return respond(200, { proposed: null, reason: 'no_photos', photo_count: 0, thin: false, sampled: [] });
  }

  // THIN is a warning, never a block. A studio with two photos should be able to try it and
  // judge the result, rather than be told no by a threshold it cannot see.
  const thin = photos.length < THIN_LIBRARY_BELOW;

  const content = photos.map((p) => ({
    type: 'image',
    source: { type: 'url', url: p.fetch_url },
  }));
  content.push({ type: 'text', text: INSTRUCTION });

  let proposed;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[derive-photo-style] anthropic', res.status, detail.slice(0, 300));
      // Do NOT surface the vendor body to the customer — it leaks provider detail and reads
      // as our product failing in someone else's words.
      return respond(502, { error: "Couldn't draft a description just now. Try again in a moment." });
    }
    const j = await res.json();
    const first = Array.isArray(j.content) ? j.content.find((c) => c.type === 'text') : null;
    proposed = first && typeof first.text === 'string' ? first.text.trim() : '';
  } catch (err) {
    console.error('[derive-photo-style] call failed:', err.message);
    return respond(502, { error: "Couldn't draft a description just now. Try again in a moment." });
  }

  if (!proposed) {
    return respond(502, { error: "Couldn't draft a description just now. Try again in a moment." });
  }
  // The model's escape hatch when a library is all screenshots and graphics. Surfacing this as
  // its own reason beats returning a confident description of a Canva template.
  if (/^NO_PHOTOGRAPHS/i.test(proposed)) {
    return respond(200, { proposed: null, reason: 'no_photographs', photo_count: photos.length, thin: false, sampled: [] });
  }

  return respond(200, {
    proposed,
    photo_count: photos.length,
    thin,
    // Returned so the owner can see WHICH photos shaped the description. A proposal she cannot
    // trace back to her own library is one she has to take on faith.
    sampled: photos.map((p) => ({ file_name: p.file_name || null, upload_date: p.upload_date || null })),
  });
};

function cors() {
  return {
    'Access-Control-Allow-Origin': process.env.DASHBOARD_ORIGIN || 'https://studio-dash.netlify.app',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function respond(status, body) {
  return { statusCode: status, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

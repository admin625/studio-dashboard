/**
 * derive-photo-keywords — derive `studio_photos.keywords` from the photograph itself.
 *
 * WHY: `keywords` is the CANDIDATE side of smart photo matching — the text a caption is scored
 * against when picking which of a studio's photos to attach to a post. It is NOT `photo_keywords`,
 * which is the post side and is already generated. Getting this column wrong is invisible: a photo
 * with weak keywords is simply never chosen, and nothing reports a photo that never wins.
 *
 * The existing human-entered keywords average 1.1 words per photo across Katie's 37 tagged rows
 * ("cycling", "studio", "core classes"). One-word tags are the caption-magnet problem: they match
 * almost any caption, so the highest-scoring photo is the vaguest one rather than the right one.
 * A floor of 3 terms exists to break that, and the >40% cross-match flag exists to catch it coming
 * back in a new costume.
 *
 * NEVER OVERWRITES HUMAN KEYWORDS. `keywords_source='human'` is excluded in the read filter AND
 * re-asserted in the UPDATE's own WHERE clause, because read-then-write is a race and these are
 * the rows a customer typed by hand.
 *
 * DRY RUN IS THE DEFAULT. `dry_run: false` must be passed explicitly to write anything.
 */
const { requireStudioAccess } = require('./_authz.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fidhmvuurygpknhshpml.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-sonnet-5';
const PROMPT_VERSION = 'keywords-v1';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 40;

// Report thresholds. These do not gate anything — they mark rows for human review.
const SPARSE_BELOW = 6;        // "either genuinely sparse images or the model being lazy"
const CROSS_MATCH_ABOVE = 0.40; // a term on >40% of the batch is a caption magnet, not a discriminator

// Two worked examples, DELIBERATELY from different modalities. One example teaches its own
// vocabulary as if it were the required vocabulary — a lone reformer example leaks springs and
// footbars into descriptions of a kettlebell class. Two examples that disagree on equipment,
// setting and body position leave only the REGISTER in common, which is the part we want copied.
const INSTRUCTION = [
  'You are shown ONE photograph from a boutique fitness studio\'s photo library.',
  '',
  'List the terms a caption about THIS photograph would plausibly contain, so the photo can be',
  'matched to the right social post. You are building search keywords, not a description.',
  '',
  'Cover what is actually visible, choosing from: equipment and apparatus - body position and',
  'movement - setting, flooring, surfaces - number of people and whether an instructor is present',
  '- apparel - shot type (close, wide, overhead) - light and time of day.',
  '',
  'Hard rules:',
  '  - 3 to 12 terms. NEVER pad to reach a number. Three precise terms beat nine vague ones.',
  '  - Prefer the SPECIFIC over the general. A term that would be true of almost any photo in any',
  '    fitness studio ("fitness", "workout", "exercise", "studio", "training") is worthless for',
  '    matching — it attracts every caption equally. Omit it unless it is genuinely the only',
  '    thing determinable.',
  '  - Describe ONLY what is visible. Never infer values, mission, personality, class name,',
  '    difficulty or price point. You cannot see those.',
  '  - Never invent detail. If something is not determinable, omit it.',
  '  - Do not name the studio, any place, any person, or any brand.',
  '  - If the image is a screenshot, exported graphic, poster or text-heavy promotional tile',
  '    rather than a photograph, reply with exactly: NOT_A_PHOTOGRAPH',
  '',
  'Form: lower case, comma-delimited, no sentences, no preamble, no heading, no trailing period.',
  '',
  'Two examples, from different modalities — copy the REGISTER, never the vocabulary:',
  '  kettlebell, swing, group class, turf flooring, mirrored wall, mid-movement, natural light',
  '  reformer, footbar, supine, spring resistance, one student, instructor cueing, neutral palette',
].join('\n');

// Stored photo_urls encode spaces (%20) but NOT '#'. Katie has Bike#1.jpg / Instructor#1.jpg live,
// and a raw '#' is a fragment delimiter — any HTTP client truncates there and fetches a 404.
const safeUrl = (u) => String(u).replace(/#/g, '%23');

// Filename match only — high precision. Designed graphics (Canva exports) are NOT caught here;
// the NOT_A_PHOTOGRAPH escape hatch handles those, since the model can see what a filename cannot.
const IS_SCREENSHOT = /(^|[^a-z])screen[ _-]?shot|screenshot/i;

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: 'Bearer ' + SERVICE_KEY,
  'Content-Type': 'application/json',
};

// A term is one or two visual attributes, not a sentence. These bounds exist because model output
// is UNTRUSTED INPUT to a database write: the instruction asks for bare comma-delimited terms, but
// an instruction is a request, not a guarantee. Without this, "Here are the keywords: reformer"
// stores a preamble as a search term and it matches captions forever.
const MAX_TERM_CHARS = 40;
const MAX_TERM_WORDS = 4;

const splitTerms = (s) => {
  let raw = String(s || '').trim();
  // Strip a leading "...:" preamble. A real visual term never contains a colon, so a colon inside
  // the first segment can only be commentary.
  const firstComma = raw.indexOf(',');
  const head = firstComma === -1 ? raw : raw.slice(0, firstComma);
  if (head.includes(':')) raw = raw.slice(raw.indexOf(':') + 1);

  const seen = new Set();
  const out = [];
  for (const piece of raw.split(',')) {
    const t = piece.trim().toLowerCase().replace(/^[-*•\s]+/, '').replace(/\.$/, '').trim();
    if (!t) continue;
    // Duplicates inflate term_count and would mask a sparse result behind a passing count.
    if (seen.has(t)) continue;
    if (t.length > MAX_TERM_CHARS) continue;
    if (t.split(/\s+/).length > MAX_TERM_WORDS) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  if (!SERVICE_KEY) return respond(500, { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' });
  if (!ANTHROPIC_API_KEY) {
    return respond(500, { error: 'ANTHROPIC_API_KEY is not configured. Set it in Netlify environment variables.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return respond(400, { error: 'Invalid JSON' }); }

  // Owner-level: this rewrites library metadata that steers which photos reach published posts.
  // Instructors are read-only on studio configuration everywhere else.
  const gate = await requireStudioAccess(event, body.studio_id, 'owner');
  if (!gate.ok) return respond(gate.status, { error: gate.error });

  // Writing requires an EXPLICIT false. An absent, null or truthy value all mean dry run, so a
  // malformed client cannot fall through into a write.
  const dryRun = body.dry_run !== false;
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  // Default targets ONLY never-touched rows. Without this the second run re-derives every row the
  // first run wrote — paying for and overwriting work already done, silently, with no diff to show
  // for it. Re-deriving is a deliberate act (a new prompt version), so it takes a deliberate flag.
  const redo = body.redo === true;

  // source='uploaded' excludes ai_generated so the model cannot keyword its own output and recycle
  // generic imagery back into the matcher that selects it.
  // is_active respects the owner's curation: archived means she removed it from the library.
  // keywords_source: NULL or non-'human' only. PostgREST cannot express this as not.eq.human —
  // NULL <> 'human' is NULL, so a plain not.eq silently drops every untouched row, which is the
  // entire population we are here to fill.
  let rows;
  try {
    const sourceFilter = redo
      ? '&or=(keywords_source.is.null,keywords_source.neq.human)'
      : '&keywords_source=is.null';
    const qs = 'studio_photos?studio_id=eq.' + encodeURIComponent(body.studio_id) +
      '&source=eq.uploaded&is_active=is.true' + sourceFilter +
      '&select=id,photo_url,file_name,upload_date,keywords,keywords_source' +
      '&order=upload_date.desc&limit=' + (limit * 3);
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + qs, { headers: sbHeaders });
    rows = await r.json();
    if (!Array.isArray(rows)) return respond(502, { error: 'studio_photos read failed' });
  } catch (err) {
    return respond(502, { error: 'Could not read the photo library.', detail: err.message });
  }

  // Belt and braces: if a 'human' row ever reaches here, drop it before it can be written to.
  const candidates = rows
    .filter((p) => p && typeof p.photo_url === 'string' && /^https?:\/\//i.test(p.photo_url))
    .filter((p) => (p.keywords_source || '') !== 'human')
    .filter((p) => !IS_SCREENSHOT.test(p.file_name || ''))
    .slice(0, limit);

  if (candidates.length === 0) {
    return respond(200, { dry_run: dryRun, considered: 0, results: [], flags: emptyFlags(), note: 'no eligible photos' });
  }

  // Concurrent, not sequential: ten vision calls at ~3-5s each would blow any sync function
  // window end to end, but overlap comfortably inside it.
  const settled = await Promise.allSettled(candidates.map((p) => deriveOne(p)));

  const results = settled.map((s, i) => {
    const p = candidates[i];
    const base = { id: p.id, file_name: p.file_name || null, photo_url: safeUrl(p.photo_url), previous_keywords: p.keywords || null };
    if (s.status === 'rejected') return { ...base, ok: false, reason: 'error', detail: String(s.reason && s.reason.message || s.reason).slice(0, 200) };
    return { ...base, ...s.value };
  });

  // Cross-match: how many photos in this batch share each term. A term carried by more than 40%
  // of the batch does not discriminate between them — it will match a caption about ANY of them.
  const derived = results.filter((r) => r.ok && Array.isArray(r.terms) && r.terms.length);
  const freq = new Map();
  for (const r of derived) {
    for (const t of new Set(r.terms)) freq.set(t, (freq.get(t) || 0) + 1);
  }
  const denom = derived.length || 1;
  const crossMatchTerms = [...freq.entries()]
    .filter(([, n]) => n / denom > CROSS_MATCH_ABOVE)
    .map(([term, n]) => ({ term, photos: n, share: Math.round((n / denom) * 100) / 100 }))
    .sort((a, b) => b.photos - a.photos);
  const crossSet = new Set(crossMatchTerms.map((c) => c.term));

  for (const r of derived) {
    r.sparse = r.terms.length < SPARSE_BELOW;
    r.cross_match_terms = r.terms.filter((t) => crossSet.has(t));
  }

  // Writes happen only after the whole batch is derived and scored, so a partial failure cannot
  // leave half a library keyworded against flags nobody has seen.
  let written = 0;
  const writeErrors = [];
  if (!dryRun) {
    for (const r of derived) {
      try {
        const ok = await writeKeywords(r.id, r.keywords);
        if (ok) { written += 1; r.written = true; }
        else { r.written = false; writeErrors.push({ id: r.id, error: 'no row updated (human-protected or vanished)' }); }
      } catch (err) {
        r.written = false;
        writeErrors.push({ id: r.id, error: err.message });
      }
    }
  }

  return respond(200, {
    dry_run: dryRun,
    redo,
    model: MODEL,
    prompt_version: PROMPT_VERSION,
    considered: candidates.length,
    derived: derived.length,
    written,
    write_errors: writeErrors,
    flags: {
      sparse_below: SPARSE_BELOW,
      sparse: derived.filter((r) => r.sparse).map((r) => ({ id: r.id, file_name: r.file_name, term_count: r.terms.length })),
      cross_match_above: CROSS_MATCH_ABOVE,
      cross_match_terms: crossMatchTerms,
    },
    results,
  });
};

async function deriveOne(p) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: safeUrl(p.photo_url) } },
          { type: 'text', text: INSTRUCTION },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('[derive-photo-keywords] anthropic', res.status, detail.slice(0, 300));
    // Never surface the vendor body — it leaks provider detail and reads as our product failing
    // in someone else's words.
    return { ok: false, reason: 'upstream', status: res.status };
  }

  const j = await res.json();
  const first = Array.isArray(j.content) ? j.content.find((c) => c.type === 'text') : null;
  const raw = first && typeof first.text === 'string' ? first.text.trim() : '';

  if (!raw) return { ok: false, reason: 'empty' };
  if (/^NOT_A_PHOTOGRAPH/i.test(raw)) return { ok: false, reason: 'not_a_photograph' };

  const terms = splitTerms(raw);
  // Below the floor the model has not followed the instruction; a 1-2 term result is the exact
  // caption-magnet shape this function exists to replace, so it is refused rather than stored.
  if (terms.length < 3) return { ok: false, reason: 'below_floor', terms, keywords: terms.join(', ') };

  const capped = terms.slice(0, 12);
  return { ok: true, terms: capped, keywords: capped.join(', ') };
}

async function writeKeywords(id, keywords) {
  const qs = 'studio_photos?id=eq.' + encodeURIComponent(id) +
    // The human guard, restated at the point of write. The read filter already excluded these;
    // this is what holds if the row changed underneath us between read and write.
    '&or=(keywords_source.is.null,keywords_source.neq.human)';
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + qs, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify({
      keywords,
      keywords_source: 'derived',
      keywords_derived_at: new Date().toISOString(),
      keywords_model: MODEL,
      keywords_prompt_version: PROMPT_VERSION,
    }),
  });
  if (!r.ok) throw new Error('PATCH ' + r.status);
  // Assert the row. A filtered PATCH that matches nothing returns 200 with an empty array —
  // success shape, zero writes.
  const back = await r.json().catch(() => []);
  return Array.isArray(back) && back.length === 1;
}

function emptyFlags() {
  return { sparse_below: SPARSE_BELOW, sparse: [], cross_match_above: CROSS_MATCH_ABOVE, cross_match_terms: [] };
}

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

// Exported for tests. splitTerms is the trust boundary between untrusted model output and a
// database write, so it is the one piece of this function that must be verifiable without
// spending an API call. Adding a named export does not disturb exports.handler.
module.exports.splitTerms = splitTerms;

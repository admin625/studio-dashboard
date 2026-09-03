#!/usr/bin/env node
/**
 * pre-commit secret scan — blocks a commit that stages a credential-shaped string.
 *
 * Exit 0 = clean, commit proceeds. Exit 1 = blocked.
 *
 * Scans ONLY added lines in the staged diff, so pre-existing content in a file you are
 * editing does not block you and history is not re-litigated on every commit.
 *
 * WHY THE ALLOWLIST EXISTS. A bare "40+ contiguous base64 chars" rule fires on ordinary
 * SQL. The literal string
 *     SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
 * is 55 such characters and is exactly what a grants dump looks like. That false positive
 * was observed on 2026-09-02 in a changelog. A gate that cries wolf on every migration
 * gets disabled within a week, so the generic rule carries two filters:
 *   1. SQL/DDL keywords and separators are stripped before the length test.
 *   2. What remains must look like entropy, not prose: it must mix lower, upper and digit,
 *      or be a long pure-hex run.
 * Prefixed patterns (sb_, eyJ, sk-ant-, …) are NOT subject to either filter. Those shapes
 * are unambiguous and are always fatal.
 *
 * Bypass is deliberately awkward: SECRET_SCAN_SKIP=1 git commit. If you reach for it,
 * the right move is almost always to remove the secret instead.
 */
'use strict'
const { execSync } = require('child_process')

if (process.env.SECRET_SCAN_SKIP === '1') {
  console.error('[secret-scan] SKIPPED via SECRET_SCAN_SKIP=1')
  process.exit(0)
}

// Unambiguous credential prefixes. No allowlist applies to these.
const PREFIXED = [
  { name: 'supabase publishable/secret key', re: /\bsb_(?:publishable|secret)?_?[A-Za-z0-9_-]{12,}/g },
  { name: 'supabase/stripe-style prefixed key', re: /\b(?:sb|sk|rk|pk|whsec|nfp)_[A-Za-z0-9]{12,}/g },
  { name: 'anthropic api key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'github PAT', re: /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g },
  { name: 'slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
]

// SQL / DDL vocabulary that legitimately produces long slash- or comma-joined runs.
const SQL_WORDS = new RegExp(
  '\\b(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|GRANT|REVOKE|EXECUTE|USAGE|' +
  'CREATE|ALTER|DROP|REPLACE|TABLE|VIEW|INDEX|POLICY|SCHEMA|FUNCTION|SEQUENCE|CONSTRAINT|' +
  'PRIMARY|FOREIGN|UNIQUE|CHECK|DEFAULT|CASCADE|RESTRICT|USING|WITH|NOT|NULL|AND|OR|ON|TO|' +
  'PUBLIC|AUTHENTICATED|ANON|SERVICE|ROLE|POSTGRES|SECURITY|DEFINER|INVOKER|STABLE|VOLATILE|' +
  'RETURNS|LANGUAGE|BEGIN|END|AS|IS|IN|ANY|ALL)\\b', 'gi')

const GENERIC = /[A-Za-z0-9+/=_-]{40,}/g

/**
 * Path-shaped exclusion for the generic rule.
 *
 * WHY: the generic character class includes `_` and `-`, so an ordinary repo path such as
 *   Decisions/ambassador/ambassador-attribution-v1
 * is a 46-char match, and the entropy test passes because it mixes case and ends in a digit.
 * That blocked a legitimate migration on 2026-09-03 — the second false positive in two days,
 * after the test-fixture block. A gate that cries wolf gets bypassed, so the rule needs to
 * know what a path looks like.
 *
 * DELIBERATELY NOT "contains a slash". Base64 contains `/` too, so exempting every match with
 * a slash would punch a hole straight through the generic rule — the one backstop for an
 * UNPREFIXED high-entropy blob (an AWS secret key, a bare signature). Instead the whole match
 * must be path-SHAPED: word/dot/hyphen segments joined by slashes, nothing else. `+` and `=`
 * are not in the segment class, so a base64 blob cannot satisfy it.
 *
 * And the exemption never applies to anything carrying a credential prefix, so
 * `path/to/sb_secret_<40>` is still blocked — belt and braces, since the prefixed rules
 * above catch that independently.
 */
const PATH_SHAPED = /^[\w.-]+(?:\/[\w.-]+)+$/
const CRED_PREFIX = /(?:^|[^A-Za-z0-9])(?:eyJ|sb_|sk-ant-|sk_|rk_|pk_|whsec_|nfp_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AKIA|xox)/

function looksLikeEntropy(tok) {
  if (/^[0-9a-f]{40,}$/i.test(tok)) return true // long pure hex
  return /[a-z]/.test(tok) && /[A-Z]/.test(tok) && /[0-9]/.test(tok)
}

function mask(s) {
  return s.length > 8 ? s.slice(0, 8) + '…' : '…'
}

let diff = ''
try {
  diff = execSync('git diff --cached --unified=0 --no-color', {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
} catch (e) {
  console.error('[secret-scan] could not read staged diff:', e.message)
  process.exit(1) // fail closed
}

const findings = []
let file = null

for (const line of diff.split('\n')) {
  const m = /^\+\+\+ b\/(.+)$/.exec(line)
  if (m) { file = m[1]; continue }
  if (!line.startsWith('+') || line.startsWith('+++')) continue
  const added = line.slice(1)

  for (const p of PREFIXED) {
    p.re.lastIndex = 0
    let hit
    while ((hit = p.re.exec(added)) !== null) {
      findings.push({ file, rule: p.name, tok: hit[0] })
    }
  }

  GENERIC.lastIndex = 0
  let g
  while ((g = GENERIC.exec(added)) !== null) {
    const raw = g[0]
    const stripped = raw.replace(SQL_WORDS, '').replace(/[^A-Za-z0-9+/=_-]/g, '')
    if (stripped.length < 40) continue          // SQL-keyword allowlist
    if (PATH_SHAPED.test(raw) && !CRED_PREFIX.test(raw)) continue  // repo path, not a secret
    if (!looksLikeEntropy(stripped)) continue   // prose / SCREAMING_CASE
    findings.push({ file, rule: 'high-entropy 40+ char run', tok: raw })
  }
}

if (findings.length === 0) process.exit(0)

console.error('')
console.error('  COMMIT BLOCKED — pre-commit secret scan found ' + findings.length + ' credential-shaped string(s).')
console.error('')
for (const f of findings) {
  console.error('    ' + f.file + '\n      rule: ' + f.rule + '\n      match: ' + mask(f.tok))
}
console.error('')
console.error('  Values are masked to 8 chars by design; the full string is never printed.')
console.error('  Remove the secret and re-stage. Emergency bypass: SECRET_SCAN_SKIP=1 git commit')
console.error('')
process.exit(1)

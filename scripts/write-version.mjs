// Emits dist/version.json after the Vite build, so the deployed site can state which commit it
// is serving without anyone holding a credential to ask.
//
// WHY THIS EXISTS. The JARVIS STATE auditor verifies STATE.md claims against live systems. It can
// read n8n and GitHub with scoped or existing credentials, but a Netlify deploy could only be
// confirmed with a Netlify PAT — and those are account-level with no read-only scope, so checking
// one claim would have meant putting a full-access production token on the n8n instance. Netlify
// also posts no commit status back to GitHub (probed 2026-09-23: zero status contexts). Serving
// the commit publicly removes the credential from the problem entirely.
//
// Written to dist/ rather than public/ on purpose: public/ is tracked, so writing there would
// leave a modified file in the working tree after every local build.
import { writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

// COMMIT_REF is set by Netlify during a build. Locally it is absent, so fall back to git, and
// then to a literal 'unknown' rather than an empty string — an empty commit would compare equal
// to nothing and could read as a match.
function resolveCommit() {
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

const payload = {
  commit: resolveCommit(),
  built_at: new Date().toISOString(),
}

mkdirSync('dist', { recursive: true })
writeFileSync('dist/version.json', JSON.stringify(payload, null, 2) + '\n')
console.log('version.json ->', payload.commit.slice(0, 7), payload.built_at)

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, existsSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * dist/version.json is what the JARVIS STATE auditor reads to confirm which commit the site is
 * serving, with no credential. If it emits an empty or malformed commit the auditor cannot tell
 * "wrong deploy" from "broken emitter", so the shape is asserted rather than assumed.
 */
const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'write-version.mjs')

function runIn(cwd, env) {
  execFileSync(process.execPath, [SCRIPT], { cwd, env: { ...process.env, ...env }, stdio: 'ignore' })
  return JSON.parse(readFileSync(path.join(cwd, 'dist', 'version.json'), 'utf8'))
}

const tmps = []
const scratch = () => { const d = mkdtempSync(path.join(tmpdir(), 'ver-')); tmps.push(d); return d }
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('write-version emits a usable version.json', () => {
  it('uses COMMIT_REF when Netlify provides it', () => {
    const j = runIn(scratch(), { COMMIT_REF: 'abcdef1234567890' })
    expect(j.commit).toBe('abcdef1234567890')
    expect(typeof j.built_at).toBe('string')
    expect(Number.isNaN(Date.parse(j.built_at))).toBe(false)
  })

  it('NEGATIVE CONTROL: with no COMMIT_REF and no git it reports "unknown", never an empty string', () => {
    // A scratch dir is not a git repo, so the git fallback fails too.
    const j = runIn(scratch(), { COMMIT_REF: '' })
    expect(j.commit).toBe('unknown')
    expect(j.commit).not.toBe('')
    // An empty commit would prefix-match nothing and could be read as a match by a naive check.
    expect('977afe8'.startsWith(j.commit)).toBe(false)
  })

  it('falls back to git HEAD when COMMIT_REF is absent but a repo is present', () => {
    const d = scratch()
    mkdirSync(path.join(d, 'src'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: d })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: d })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim()
    const j = runIn(d, { COMMIT_REF: '' })
    expect(j.commit).toBe(head)
  })

  it('emits valid JSON with exactly the two documented fields', () => {
    const d = scratch()
    runIn(d, { COMMIT_REF: 'deadbeef' })
    const raw = readFileSync(path.join(d, 'dist', 'version.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['built_at', 'commit'])
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('creates dist/ when it does not exist yet', () => {
    const d = scratch()
    expect(existsSync(path.join(d, 'dist'))).toBe(false)
    runIn(d, { COMMIT_REF: 'abc' })
    expect(existsSync(path.join(d, 'dist', 'version.json'))).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import {
  classifyStudioLoadError,
  describeStudioLoadFailure,
  STUDIO_LOAD_TIMEOUT,
  STUDIO_LOAD_NO_ROW,
  STUDIO_LOAD_DB_ERROR,
  STUDIO_LOAD_NETWORK,
  STUDIO_LOAD_UNKNOWN,
} from './studioLoadDiagnostics'

describe('classifyStudioLoadError', () => {
  it('classifies our own timeout abort', () => {
    expect(classifyStudioLoadError(new Error('TIMEOUT: studio_accounts (5000ms)')))
      .toBe(STUDIO_LOAD_TIMEOUT)
  })

  it('classifies PGRST116 as no_row, not as a database error', () => {
    // .single() with zero rows. Under RLS this is how a DENIED read arrives -
    // it must not be reported as a DB fault, and retrying it is pointless.
    const err = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }
    expect(classifyStudioLoadError(err)).toBe(STUDIO_LOAD_NO_ROW)
  })

  it('classifies any other PostgREST code as a database error', () => {
    expect(classifyStudioLoadError({ code: '42501', message: 'permission denied' }))
      .toBe(STUDIO_LOAD_DB_ERROR)
  })

  it('classifies a fetch TypeError as network', () => {
    expect(classifyStudioLoadError(new TypeError('Failed to fetch')))
      .toBe(STUDIO_LOAD_NETWORK)
  })

  it('falls back to unknown rather than guessing', () => {
    expect(classifyStudioLoadError({})).toBe(STUDIO_LOAD_UNKNOWN)
    expect(classifyStudioLoadError(null)).toBe(STUDIO_LOAD_UNKNOWN)
    expect(classifyStudioLoadError('a string')).toBe(STUDIO_LOAD_UNKNOWN)
  })

  it('prefers timeout over code when both are present', () => {
    const err = Object.assign(new Error('TIMEOUT: studio_accounts (8000ms)'), { code: 'PGRST116' })
    expect(classifyStudioLoadError(err)).toBe(STUDIO_LOAD_TIMEOUT)
  })
})

describe('describeStudioLoadFailure', () => {
  it('produces a DIFFERENT string per kind - the whole point of the change', () => {
    const args = { attempts: 2, elapsedMs: 13250 }
    const lines = [
      describeStudioLoadFailure(STUDIO_LOAD_TIMEOUT, args),
      describeStudioLoadFailure(STUDIO_LOAD_NO_ROW, args),
      describeStudioLoadFailure(STUDIO_LOAD_DB_ERROR, { ...args, code: '42501', message: 'nope' }),
      describeStudioLoadFailure(STUDIO_LOAD_NETWORK, { ...args, message: 'Failed to fetch' }),
    ]
    expect(new Set(lines).size).toBe(4)
  })

  it('states what a timeout is NOT, so it cannot be read as a DB fault', () => {
    const line = describeStudioLoadFailure(STUDIO_LOAD_TIMEOUT, { attempts: 2, elapsedMs: 13250 })
    expect(line).toMatch(/CLIENT TIMEOUT/)
    expect(line).toMatch(/NOT a database error/)
    expect(line).toMatch(/attempts=2/)
    expect(line).toMatch(/elapsed=13250ms/)
  })

  it('says retrying will not help a no_row result', () => {
    const line = describeStudioLoadFailure(STUDIO_LOAD_NO_ROW, { attempts: 1, elapsedMs: 42 })
    expect(line).toMatch(/RLS denied/)
    expect(line).toMatch(/retrying will not help/)
  })

  it('carries the postgres code through on a db error', () => {
    const line = describeStudioLoadFailure(STUDIO_LOAD_DB_ERROR, { attempts: 1, elapsedMs: 30, code: '42501', message: 'permission denied' })
    expect(line).toMatch(/code=42501/)
    expect(line).toMatch(/permission denied/)
  })
})

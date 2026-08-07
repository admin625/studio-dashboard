import { describe, it, expect, vi } from 'vitest'
import { retryWithTimeout } from './retryWithTimeout'

const never = () => new Promise(() => {})
const slow = (ms, value) => () => new Promise(r => setTimeout(() => r(value), ms))

describe('retryWithTimeout', () => {
  it('returns the first attempt without retrying when it resolves in time', async () => {
    const thunk = vi.fn(slow(10, { data: 'ok' }))
    const onRetry = vi.fn()
    const out = await retryWithTimeout(thunk, { ceilings: [50, 100], backoffMs: 0, label: 't', onRetry })
    expect(out).toEqual({ data: 'ok' })
    expect(thunk).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('retries once on timeout and succeeds under the higher ceiling', async () => {
    // Resolves at 80ms: past the 50ms first ceiling, inside the 200ms second.
    const thunk = vi.fn(slow(80, { data: 'late' }))
    const onRetry = vi.fn()
    const out = await retryWithTimeout(thunk, { ceilings: [50, 200], backoffMs: 0, label: 'studio_accounts', onRetry })
    expect(out).toEqual({ data: 'late' })
    expect(thunk).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0][0].message).toMatch(/TIMEOUT: studio_accounts \(50ms\)/)
  })

  it('calls the thunk fresh each attempt rather than re-awaiting one promise', async () => {
    // Guards the Supabase-thenable trap: a builder awaited twice is not two requests.
    let calls = 0
    const thunk = () => {
      calls++
      return calls === 1 ? never() : Promise.resolve({ data: calls })
    }
    const out = await retryWithTimeout(thunk, { ceilings: [30, 100], backoffMs: 0, label: 't' })
    expect(out).toEqual({ data: 2 })
    expect(calls).toBe(2)
  })

  it('throws the last error after both attempts time out', async () => {
    const thunk = vi.fn(never)
    await expect(
      retryWithTimeout(thunk, { ceilings: [20, 30], backoffMs: 0, label: 'studio_accounts' })
    ).rejects.toThrow('TIMEOUT: studio_accounts (30ms)')
    expect(thunk).toHaveBeenCalledTimes(2)
  })

  it('retries a rejection, not only a timeout', async () => {
    const thunk = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ data: 'recovered' })
    const out = await retryWithTimeout(thunk, { ceilings: [50, 100], backoffMs: 0, label: 't' })
    expect(out).toEqual({ data: 'recovered' })
    expect(thunk).toHaveBeenCalledTimes(2)
  })

  it('annotates the thrown error with attempts ACTUALLY made and elapsed time', async () => {
    const thunk = vi.fn(never)
    try {
      await retryWithTimeout(thunk, { ceilings: [20, 30], backoffMs: 0, label: 'studio_accounts' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err.attempts).toBe(2)
      expect(err.elapsedMs).toBeGreaterThanOrEqual(45)
      // attemptMs is the LAST attempt only, so it must be positive and never
      // exceed the total. Don't pin it to the ceiling - timer granularity can
      // land it a millisecond under.
      expect(err.attemptMs).toBeGreaterThan(0)
      expect(err.attemptMs).toBeLessThanOrEqual(err.elapsedMs)
    }
  })

  it('reports ONE attempt when the thunk rejects without a retry configured', async () => {
    // Guards the false-claim bug: a single-ceiling run must never be described
    // as having retried.
    const thunk = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'PGRST116' }))
    await expect(
      retryWithTimeout(thunk, { ceilings: [50], backoffMs: 0, label: 'studio_accounts' })
    ).rejects.toMatchObject({ attempts: 1, code: 'PGRST116' })
    expect(thunk).toHaveBeenCalledTimes(1)
  })

  it('passes the attempt number and elapsed ms to onRetry', async () => {
    const onRetry = vi.fn()
    await retryWithTimeout(slow(60, { data: 'ok' }), { ceilings: [30, 200], backoffMs: 0, label: 't', onRetry })
    expect(onRetry).toHaveBeenCalledTimes(1)
    const [, attempt, attemptMs] = onRetry.mock.calls[0]
    expect(attempt).toBe(1)
    expect(attemptMs).toBeGreaterThanOrEqual(30)
  })

  it('does not throw when the rejection value is a primitive', async () => {
    const thunk = vi.fn().mockRejectedValue('plain string rejection')
    await expect(
      retryWithTimeout(thunk, { ceilings: [20], backoffMs: 0, label: 't' })
    ).rejects.toBe('plain string rejection')
  })

  it('waits the backoff between attempts', async () => {
    const thunk = vi.fn()
      .mockRejectedValueOnce(new Error('cold'))
      .mockResolvedValueOnce({ data: 'ok' })
    const start = Date.now()
    await retryWithTimeout(thunk, { ceilings: [50, 100], backoffMs: 60, label: 't' })
    expect(Date.now() - start).toBeGreaterThanOrEqual(55)
  })
})

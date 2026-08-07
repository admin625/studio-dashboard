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

  it('waits the backoff between attempts', async () => {
    const thunk = vi.fn()
      .mockRejectedValueOnce(new Error('cold'))
      .mockResolvedValueOnce({ data: 'ok' })
    const start = Date.now()
    await retryWithTimeout(thunk, { ceilings: [50, 100], backoffMs: 60, label: 't' })
    expect(Date.now() - start).toBeGreaterThanOrEqual(55)
  })
})

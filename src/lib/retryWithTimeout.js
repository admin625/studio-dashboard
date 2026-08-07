import { withTimeout } from './withTimeout'

/**
 * Run a query under a timeout, retrying once with a higher ceiling.
 *
 * Takes a THUNK, not a promise, so each attempt issues a genuinely new request.
 * Supabase query builders are thenables that execute on await — awaiting the
 * same builder twice is not a second attempt, so the thunk is load-bearing.
 *
 * Note `withTimeout` does not abort the underlying request (see its docstring),
 * so attempt 1 may still be in flight when attempt 2 starts. That is fine for a
 * read, and it is the point: a cold connection gets a second, longer chance
 * rather than one longer wait.
 *
 * `onRetry` fires between attempts. Callers are expected to use it — a retry
 * nobody can observe reproduces the failure this exists to fix.
 */
export async function retryWithTimeout(thunk, { ceilings = [5000, 8000], backoffMs = 250, label, onRetry } = {}) {
  let lastErr
  for (let i = 0; i < ceilings.length; i++) {
    try {
      return await withTimeout(thunk(), ceilings[i], label)
    } catch (err) {
      lastErr = err
      if (i === ceilings.length - 1) break
      onRetry?.(err, i + 1)
      if (backoffMs) await new Promise(r => setTimeout(r, backoffMs))
    }
  }
  throw lastErr
}

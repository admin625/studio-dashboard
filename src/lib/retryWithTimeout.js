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
  const startedAt = Date.now()
  let lastErr
  let attemptsMade = 0

  for (let i = 0; i < ceilings.length; i++) {
    const attemptStartedAt = Date.now()
    attemptsMade = i + 1
    try {
      return await withTimeout(thunk(), ceilings[i], label)
    } catch (err) {
      lastErr = err
      const attemptMs = Date.now() - attemptStartedAt
      annotate(err, { attempt: attemptsMade, attemptMs, elapsedMs: Date.now() - startedAt })
      if (i === ceilings.length - 1) break
      onRetry?.(err, attemptsMade, attemptMs)
      if (backoffMs) await new Promise(r => setTimeout(r, backoffMs))
    }
  }
  // Report attempts ACTUALLY made, never the configured count — a caller that
  // rethrows after one attempt must not be described as having retried.
  annotate(lastErr, { attempts: attemptsMade, elapsedMs: Date.now() - startedAt })
  throw lastErr
}

// Errors are usually objects, but a thunk may reject with a primitive. Never let
// instrumentation be the thing that throws.
function annotate(err, fields) {
  if (err && typeof err === 'object') {
    try { Object.assign(err, fields) } catch { /* frozen error — ignore */ }
  }
}

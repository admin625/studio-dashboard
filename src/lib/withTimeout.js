/**
 * Race a promise against a timeout. If the promise doesn't settle within `ms`
 * milliseconds, the returned promise rejects with a TIMEOUT error.
 *
 * Note: This does NOT abort the underlying operation — it only rejects the
 * outer promise. Use for guarding UI state, not canceling network traffic.
 */
export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT: ${label} (${ms}ms)`)), ms)
    ),
  ])
}

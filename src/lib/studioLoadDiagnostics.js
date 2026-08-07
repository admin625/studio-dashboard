/**
 * Classify why a studio_accounts load failed.
 *
 * The point is that these have completely different diagnoses and used to
 * produce the same log string:
 *
 *   client_timeout — no server response inside our own ceiling. We aborted; the
 *                    query may well have completed server-side. NOT a DB fault.
 *   no_row         — the server answered fine and returned zero rows. With
 *                    .single() that arrives as PostgREST error PGRST116, not as
 *                    data:null, so it is an *error* that is not a failure:
 *                    RLS denied this studio_id, or the id is wrong.
 *   db_error       — the server answered with a real error (constraint, syntax,
 *                    permission, connection).
 *   network        — fetch itself failed (offline, DNS, CORS, TLS).
 */
export const STUDIO_LOAD_TIMEOUT = 'client_timeout'
export const STUDIO_LOAD_NO_ROW = 'no_row'
export const STUDIO_LOAD_DB_ERROR = 'db_error'
export const STUDIO_LOAD_NETWORK = 'network'
export const STUDIO_LOAD_UNKNOWN = 'unknown'

export function classifyStudioLoadError(err) {
  const message = typeof err?.message === 'string' ? err.message : ''
  if (message.startsWith('TIMEOUT:')) return STUDIO_LOAD_TIMEOUT
  // PGRST116: ".single() expected exactly one row". Under RLS a denied read is
  // indistinguishable from a missing row — both are zero rows to PostgREST.
  if (err?.code === 'PGRST116') return STUDIO_LOAD_NO_ROW
  if (err?.code) return STUDIO_LOAD_DB_ERROR
  if (err instanceof TypeError) return STUDIO_LOAD_NETWORK
  return STUDIO_LOAD_UNKNOWN
}

/**
 * One line per failure kind, each stating what it is AND what it is not, so a
 * console line is a diagnosis rather than a prompt to guess.
 */
export function describeStudioLoadFailure(kind, { attempts = 1, elapsedMs = 0, code = null, message = '' } = {}) {
  const at = `attempts=${attempts} elapsed=${elapsedMs}ms`
  switch (kind) {
    case STUDIO_LOAD_TIMEOUT:
      return `[FCA] studio_accounts CLIENT TIMEOUT (${at}) — no server response within our ceiling on any attempt. This is a client-side abort, NOT a database error; the query may have completed server-side.`
    case STUDIO_LOAD_NO_ROW:
      return `[FCA] studio_accounts NO ROW (${at}) — the server answered successfully and returned zero rows. RLS denied this studio_id, or the id is wrong. NOT a timeout, NOT a slow query; retrying will not help.`
    case STUDIO_LOAD_DB_ERROR:
      return `[FCA] studio_accounts DATABASE ERROR (${at}) code=${code ?? 'n/a'} — the server responded with an error: ${message}`
    case STUDIO_LOAD_NETWORK:
      return `[FCA] studio_accounts NETWORK FAILURE (${at}) — the request never completed at the transport layer (offline, DNS, CORS or TLS): ${message}`
    default:
      return `[FCA] studio_accounts UNKNOWN FAILURE (${at}) — unrecognised error shape: ${message}`
  }
}

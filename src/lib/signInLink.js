/**
 * AG-1.4 Part 1 — the "Email me a sign-in link" button on /login.
 *
 * WHY THE ANSWER IS THE SAME FOR EVERY ADDRESS. The button calls signInWithOtp with
 * shouldCreateUser:false, so an address with no account is refused by GoTrue — and GoTrue says
 * so, in an error. Showing that error would tell anyone who types an email whether it has an FCA
 * account. So "no such user" is deliberately classified the same as success: the studio sees
 * "If that email has an account, a link is on its way." either way.
 *
 * shouldCreateUser:false is the other half of the same decision: without it, a typo would mint an
 * auth user with no studio behind it, bypassing provisioning (q7) entirely.
 *
 * Only two things are distinguishable on screen: the 60-second per-address rate limit (so a studio
 * clicking twice is told to wait rather than that it failed) and a genuine failure (so nothing
 * fails silently).
 */

export const SIGN_IN_LINK_MESSAGES = {
  sent: 'If that email has an account, a link is on its way. Check your inbox (and spam).',
  rate_limited: 'A link was just sent. Please wait a minute and try again.',
  error: "We couldn't send a sign-in link just now. Please try again.",
  need_email: 'Enter your email above first.',
}

/**
 * Map a supabase-js signInWithOtp error (or null) to 'sent' | 'rate_limited' | 'error'.
 * Total: anything unrecognised is 'error', never 'sent' — except the no-such-user family, which is
 * 'sent' on purpose (see above).
 */
export function classifyOtpError(err) {
  if (!err) return 'sent'
  const code = String(err.code || '').toLowerCase()
  const msg = String(err.message || '')
  const status = Number(err.status || 0)
  if (status === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' ||
      /only request this after|rate limit/i.test(msg)) return 'rate_limited'
  if (code === 'otp_disabled' || code === 'user_not_found' || code === 'signup_disabled' ||
      /signups not allowed|user not found/i.test(msg)) return 'sent'
  return 'error'
}

import { describe, it, expect } from 'vitest'
import { classifyOtpError, SIGN_IN_LINK_MESSAGES } from '../src/lib/signInLink'

/**
 * AG-1.4c/d. The one property that matters: an address with no account and an address with one
 * get the SAME message. If "no such user" ever classifies as anything but 'sent', the button
 * becomes an account-existence oracle for anyone with the login page open.
 */
describe('classifyOtpError', () => {
  it('success is sent', () => {
    expect(classifyOtpError(null)).toBe('sent')
    expect(classifyOtpError(undefined)).toBe('sent')
  })
  it('no-such-user (shouldCreateUser:false) is indistinguishable from success', () => {
    expect(classifyOtpError({ status: 422, code: 'otp_disabled', message: 'Signups not allowed for otp' })).toBe('sent')
    expect(classifyOtpError({ status: 400, message: 'Signups not allowed for otp' })).toBe('sent')
    expect(classifyOtpError({ code: 'user_not_found', message: 'User not found' })).toBe('sent')
  })
  it('the 60s per-address limit says wait, not failed', () => {
    expect(classifyOtpError({ status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 42 seconds.' })).toBe('rate_limited')
    expect(classifyOtpError({ message: 'For security purposes, you can only request this after 59 seconds.' })).toBe('rate_limited')
    expect(classifyOtpError({ status: 429, message: 'Email rate limit exceeded' })).toBe('rate_limited')
  })
  it('anything else is a visible error, never silent and never "sent"', () => {
    expect(classifyOtpError({ message: 'Failed to fetch' })).toBe('error')
    expect(classifyOtpError({ status: 500, message: 'Error sending magic link email' })).toBe('error')
    expect(classifyOtpError({})).toBe('error')
  })
  it('every outcome has a message, and sent does not reveal existence', () => {
    for (const k of ['sent', 'rate_limited', 'error', 'need_email']) expect(SIGN_IN_LINK_MESSAGES[k]).toBeTruthy()
    expect(SIGN_IN_LINK_MESSAGES.sent).toMatch(/^If that email has an account/)
  })
})

import { Link } from 'react-router-dom'

/**
 * The post-checkout landing state: "we've sent you a sign-in link".
 *
 * WHY THIS EXISTS. The Stripe payment link's success_url is /auth/callback, the same route a
 * magic link lands on. That route used to do one thing: call getSession() and navigate. But
 * getSession() cannot tell "just authenticated by the link in this URL" from "was already signed
 * in on this browser three weeks ago" -- both return a session. So a studio who bought while
 * signed in to a DIFFERENT studio was redirected straight into that other studio's deliveries.
 * That is the 2026-09-08 bare-link control. The handoff was never broken; the magic link email
 * sends fine. What was missing was a success page, so the route fell through to a redirect.
 *
 * ON THE MISSING ADDRESS. This deliberately renders no email address. Resolving Stripe's
 * ?session_id= to the checkout email requires checkout.sessions.retrieve, which needs a secret
 * key and therefore a server endpoint -- a public one mapping a session id to a person's email.
 * That was scoped out (HQ, 2026-09-09) in favour of copy that needs no such surface. The `email`
 * prop below is honoured if it is ever supplied, so adding the address later is a one-line change
 * at the call site rather than a rewrite here.
 */
export default function CheckYourEmail({ email = null, signedInAs = null, onSignOut = null }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#0A0B0D' }}>
      <div className="w-full max-w-sm text-center">
        <div
          className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-6"
          style={{ background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-secondary) 100%)' }}
        >
          <span className="text-white text-xl font-bold font-display">F</span>
        </div>

        <h1
          className="text-white mb-3"
          style={{
            fontFamily: "'Bebas Neue', sans-serif",
            fontSize: 'clamp(2rem, 5vw, 2.8rem)',
            letterSpacing: '0.03em',
            lineHeight: 1,
          }}
        >
          Check your email
        </h1>

        <p className="text-slate-300 text-sm leading-relaxed mb-8">
          {email ? (
            <>We&apos;ve sent a sign-in link to <span className="text-white">{email}</span>. </>
          ) : (
            <>We&apos;ve sent a sign-in link to the email address you used at checkout. </>
          )}
          Open it on this device to finish setting up your studio. Check your spam folder, just in case.
        </p>

        {/*
          A session in localStorage is exactly what caused the original defect, so when one is
          present we say so plainly and offer the way out. Signing out here must NOT navigate:
          the studio still needs to read this page and go to their inbox. AuthProvider's
          onAuthStateChange picks up SIGNED_OUT and resets the app context on its own.
        */}
        {signedInAs && (
          <div
            className="px-4 py-3 rounded-lg text-xs leading-relaxed text-slate-400 mb-6"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            You&apos;re still signed in as <span className="text-slate-200">{signedInAs}</span> on this browser.
            The link in your email will sign you in to the new studio.
            {onSignOut && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={onSignOut}
                  className="underline transition-colors"
                  style={{ color: 'var(--brand-primary)' }}
                >
                  Sign out
                </button>
                {' now if you prefer.'}
              </>
            )}
          </div>
        )}

        <Link
          to="/login"
          className="text-xs uppercase tracking-wider transition-colors"
          style={{ color: 'var(--brand-primary)' }}
        >
          ← Back to login
        </Link>
      </div>
    </div>
  )
}

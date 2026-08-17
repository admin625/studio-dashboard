# FCA Studio Dashboard — Project CLAUDE.md

> Read this at the start of every session. Do not skip it.
>
> **Rewritten 2026-08-07.** The previous version described a vanilla-JS single-file SPA with no
> build step and no server-side secrets. None of that has been true for some time — it is a Vite +
> React app with eight Netlify Functions holding service-role and API keys. If you find a claim
> here that the code contradicts, the code wins; fix this file in the same session.

## What This Is

FCA (Fitness Content Agent) is an AI-powered social content platform for boutique fitness studios.
This repo (`admin625/studio-dashboard`) is the seller-facing dashboard — the primary UI for studio
owners and instructors. Content generation happens in n8n workflows that write to Supabase; this
dashboard reads, displays, and edits that data, and triggers generation via a webhook proxy.

**Target users:** boutique fitness studio owners (yoga, pilates, barre, cycling, HIIT, CrossFit,
boxing, dance) and their instructors.

> ⚠️ **This repository is PUBLIC.** Anything committed here is world-readable, and it has leaked a
> webhook signing secret before. Never commit a secret, and never render a secret into the client
> bundle — see *Secrets* below.

## Current Build State

Live at **https://app.fiorsaoirse.com** (Netlify site `studio-dash`, ID `1e0a46ea-f313-4ff0-acdf-65ae6bd3bd58`).
The `.netlify.app` subdomain and the custom domain are the same one site and one deploy — they
cannot diverge. Environment variables belong on the **studio-dash** site.

## Tech Stack — verified against the repo 2026-08-07

- **Frontend:** React 19 + React Router 7, built with **Vite 8**. Tailwind CSS 4 via
  `@tailwindcss/vite`. Icons from `lucide-react`.
- **There IS a build step.** `npm run build` → `vite build` → `dist/`. Publish directory is `dist`,
  not the repo root.
- **Tests:** Vitest (`npm test` → `vitest run`).
- **Backend:** Netlify Functions in `netlify/functions/` (esbuild bundler, Node 20).
- **Database:** Supabase `fidhmvuurygpknhshpml` (us-east-1).
- **Content generation:** n8n Cloud (`jmac.app.n8n.cloud`) → Claude API → Supabase.
- **Deploy:** continuous deployment from `main`. Push → Netlify builds → publishes `dist/` and
  bundles the functions.

```
src/
  main.jsx, App.jsx          — entry + routes
  components/                — AuthProvider, ProtectedRoute, Layout, ErrorBoundary,
                               DeliveryList, PostCard, PhotoGallery, GenerateModal,
                               NewReelModal, HelpChatWidget
  pages/                     — Login, AuthCallback, ForgotPassword, Dashboard, DeliveryView,
                               BrandSettings, Photos, Reels, ReelUpload, AccountSettings, Scaffold
  context/AppContext.jsx     — single app-wide state object (INITIAL_STATE + update/reset)
  hooks/                     — useAuth, useBrandSettings
  lib/                       — supabase, withTimeout, retryWithTimeout, brandFonts, image,
                               downloadUrl (photo download names + ?download param),
                               deepLink (email deep link, `?next=` carrier, post-login
                               route allowlist — a security boundary, see Routes)
netlify/functions/           — see table below
netlify.toml                 — build config, function timeouts, SPA redirect
index.html                   — 21-line Vite entry point (NOT the app)
legacy/index.html            — the retired ~2,450-line vanilla-JS SPA. Historical only. Do not edit.
scripts/                     — one-off ops scripts (setup-fca-auth-users.js)
workflows/                   — README only; n8n workflow notes
```

### Routes

`/login` · `/auth/callback` · `/forgot-password` are public. Everything else is wrapped in
`ProtectedRoute`: `/deliveries` (default) · `/delivery/:id` · `/photos` · `/reels` ·
`/reels/upload` · `/brand` · `/settings/account`. Unknown paths redirect to `/deliveries`.

`/delivery/:id` is keyed by `id` so the component fully remounts per delivery — React Router reuses
the instance across param changes, which otherwise bleeds prior delivery state into the next one.

**`/` honours `?id=<delivery_id>` and routes to `/delivery/:id`.** Delivery emails emit
`/?id=<delivery_id>` — the route shape of the retired vanilla SPA, which read it via
`URLSearchParams`. The React rewrite never read a query param, so from the rewrite until
2026-08-17 every studio arriving by email was silently dropped on the deliveries list.
Neither side errored, which is why it went unseen. Fixed in the app rather than the email
template because already-sent emails carry this URL and only an app-side fix repairs those.
The id is UUID-validated before it is interpolated into a path; anything else falls through
to `/deliveries`, the previous behaviour.

**The intended destination survives login, and it rides in the URL — `?next=`.** Without it the
deep link would work only for sessions already signed in, and the dominant case is a logged-out
click from an email.

The carrier is `?next=<path>` on every hop, with no storage anywhere:

```
ProtectedRoute → /login?next= → /forgot-password?next= → emailRedirectTo → /auth/callback?next=
```

⚠️ **`/login` → `/forgot-password` is part of the chain, not a detour.** `loginWithMagicLink` is
not called from `Login.jsx` — it lives on `ForgotPassword.jsx`, so the magic-link path *always*
goes through that hop. A link between those two pages that drops the parameter kills the
destination silently on the majority path. It shipped that way for a few hours on 2026-08-17 and
was caught by tracing the call graph, not by reading the plan. Build every in-app hop with
`withNext()`.

**An earlier version stashed the destination in `sessionStorage`. Do not reintroduce it.**
`sessionStorage` is per-tab and mail clients open links in a new tab, so the stash was unreadable
on the one path that matters most. It could not work for magic links even in principle. The email
itself demonstrated the better carrier: `redirect_to` already survives the whole GoTrue round trip.
Removing the stash also removed its two known defects — an untimed stale destination and a
render-phase write — so neither is a live trade-off any more.

🚨 **Read-side validation is the entire defense, and it is not optional at any consumption point.**
`POST /auth/v1/otp` is reachable with the **public anon key**, so anyone can mint a genuine magic
link for any existing studio owner carrying an arbitrary `redirect_to` — including
`/auth/callback?next=https://evil.example`. The victim authenticates for real and is then sent
wherever `next` says. **Validating when we write the parameter is worthless — an attacker never
uses our write path.** Every point that *reads* `next` must go through `nextPathFromQuery()`, which
allowlists it: `AuthCallback`, `Login`, `ForgotPassword`. No exceptions, and no "this one is
internal" carve-outs. `nextPathFromQuery` never returns null, so there is no fallback to forget.

The allowlist lives in exactly one place, `lib/deepLink.js`. Three or four copies would drift, and
drift in a security check is how a hole opens quietly. It takes a **path, never a URL** — do not
"add support for full URLs", that is the open redirect it exists to prevent.

⚠️ **If you add an authenticated route, add it to `STATIC_PATHS`** or a post-login return to it
silently falls back to `/deliveries`.

Covered by `test/deepLink.test.js` (77 cases). The hostile-input set is a single shared `HOSTILE`
array reused across every carrier, so a new carrier cannot be added with a weaker rejection set.
Keep it that way — that property is structural, not a matter of remembering.

### Netlify Functions

| Function | Notes |
|---|---|
| `_authz.cjs` | Shared authz gate. `requireStudioAccess(event, studioId, level)` — `level` is **required, no default** |
| `reels.cjs` | Reel CRUD |
| `derive-photo-style.cjs` | Drafts `ai_photo_prompt` from a studio's own photos. 26s timeout |
| `derive-photo-keywords.cjs` | Derives `studio_photos.keywords` (the CANDIDATE side of photo matching) from each photo. Owner-level. **Dry run by default** — writing needs `dry_run:false`; re-deriving needs `redo:true`. Never overwrites `keywords_source='human'`. 26s timeout |
| `generate-content.js` | Generation entry point |
| `proxy-webhook.js` | Fronts n8n webhooks. 26s timeout (set in `netlify.toml`) |
| `help-chat.js` | Help chat backend |
| `reel-create-background.js` | Background function for reel creation |
| `watermark.js` | Logo watermarking |

> 🚨 **Every file in `netlify/functions/` becomes a deployable function, and a function name must
> be alphanumeric + hyphen + underscore only.** One dot fails the **entire** deploy — not just that
> file — with `Incorrect function names`. A `*.test.js` beside its function did exactly that on
> 2026-08-08 (deploy `6a775dc9`). Function tests live in `test/`, never in `netlify/functions/`.
> A failed deploy never publishes, so the symptom is the *previous* commit still being served and
> the new endpoint returning 404 — which reads exactly like "CD isn't running". It isn't. Check
> `netlify api listSiteDeploys` for `state: error` before concluding anything about CD.

> 🚨 **A function that `require`s a LOCAL file must be named `.cjs`.** `package.json` sets
> `"type": "module"`, so as soon as a function requires a local module, Netlify bundles it as ESM
> and `exports.handler` stops registering → `Runtime.HandlerNotFound`. This took `reels` down for
> ~2 hours on 2026-08-06. Functions are named by basename, so renaming `.js` → `.cjs` does not
> change the function URL. Verifying that esbuild can *resolve* an import does **not** verify that
> the deployed artifact *exports a handler* — check the deployed function, not the bundle graph.

## Secrets

**Client (bundled, world-readable):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Anything
prefixed `VITE_` is compiled into the JS bundle. Never put a non-public value behind that prefix.

**Server-side (Netlify Functions env, never bundled):** `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `HELP_CHAT_WEBHOOK_SECRET`,
`LOGO_COMPOSITE_SERVICE_URL`, `LOGO_COMPOSITE_SHARED_SECRET`, `DASHBOARD_ORIGIN`.

The old claim "no server-side secrets in this repo" is false and was load-bearing in the wrong
direction — treat every function as secret-holding.

## Auth Model

Supabase Auth, email-anchored, with RLS on every table.

### Origins — the app does not get the last word on where a magic link lands

🚨 **GoTrue honours `emailRedirectTo` only when it matches the Redirect URLs allowlist. On no
match it silently falls back to Site URL — no error, on either side.** So this repo can request
the correct host and be overridden by a dashboard setting it cannot see. That is exactly what
happened: Site URL and all five allowlist entries were `studio-dash.netlify.app` while the app
asked for `app.fiorsaoirse.com`, and because **sessions are origin-scoped**, every studio signing
in by magic link ended up authenticated on the netlify subdomain and still logged out on the
custom domain. Magic link is the only self-serve auth email in the product.

Fixed 2026-08-17 in the Supabase dashboard, not in this repo:

| Setting | Value |
|---|---|
| Site URL | `https://app.fiorsaoirse.com` (rollback: `https://studio-dash.netlify.app`) |
| Redirect URLs | `app.fiorsaoirse.com/auth/callback` + `app.fiorsaoirse.com/**`, **plus all five original netlify entries incl. `deploy-preview-*`** |

`/**` is what lets a query-bearing callback through, which is why `?next=` needs no allowlist
entry of its own. Verified by round trip, not assumed.

⚠️ **Two origins still work, with independent sessions.** Collapsing them needs a Netlify 301 and
forces a one-time re-auth for everyone — a separate decision, deliberately not bundled. ⚠️ **The
delivery email still emits `studio-dash.netlify.app/?id=`**, so a studio clicking it lands on the
deprecated origin and re-authenticates there. That fix is an n8n edit on `pTTpsIlhtOYHqvXd`, not
a change here. ⚠️ Supabase dashboard config fields can store invisible trailing whitespace that
propagates as `%20` — check with End/Shift+End, never by eye.

**Role resolution (`AuthProvider.jsx`), in order:**

1. **Admin bypass** — `ADMIN_ACCOUNTS` maps an email to `role`/`studioId`/`clientId`/`scopeType`.
   It skips the *role lookup only*. ⚠️ Do **not** reintroduce a `studioData` key here: it used to
   bake brand fields in and skip the `studio_accounts` query, so the admin session rendered a
   correct-looking role and studio name from literals while `brand_font`, `brand_voice`,
   `brand_color_secondary`, `studio_type`, `is_beta` and all three logo URLs came through blank —
   every one of them populated in the database the whole time. That is a data-loss path, not a
   display bug, because BrandSettings saves what it displays.
2. **JWT fast path** — `app_metadata.role` plus the `fca_studio_id` claim injected by the
   server-side `custom_access_token_hook`. Resolves synchronously; cannot be left null by a slow
   query.
3. **Table lookup fallback** — `studio_instructors` then `clients`, for individual-scope and
   legacy sessions with no claim.

Roles: `studio_owner` (everything) and `studio_instructor` (own deliveries only; no settings).
The JWT carries `studio_owner` / `instructor`; the app gates on `studio_owner` /
`studio_instructor` — `normalizeRole()` bridges the two.

> ⚠️ All three resolvers compare email **exactly, with no `lower()`**. One capital letter is a
> silent lockout. A studio owner must also have a `clients` row.

### Timeouts and the hydration gate

Every Supabase read in `AuthProvider` is wrapped in `withTimeout` (5s), which races a promise but
does **not** abort the underlying request. `studio_accounts` additionally uses
`retryWithTimeout` — one retry at a higher ceiling (5s → 8s, 250 ms backoff). It takes a **thunk**,
not a promise, because a Supabase query builder is a thenable that executes on `await`; re-awaiting
one object is not a second attempt.

A 10s safety valve force-sets `authReady` if nothing else has. **It sets `authReady` alone, with no
brand fields.** So `authReady` is a proxy for hydration, not hydration itself. Anything that can
*write* brand data must gate on **`studioLoaded`**, never on `authReady` — `BrandSettings` does,
error branch first so a failed load explains itself instead of spinning forever.

⚠️ Every failure path here ends in `console.warn`/`console.error`. There is no beacon, no row, no
counter — the real-world failure rate is **unknowable as built**, not merely unmeasured. Do not
describe it as rare. `studioLoadRetried` makes a retry visible in app state; nothing persists it.

## Supabase (`fidhmvuurygpknhshpml`)

Tables this repo reads or writes: `studio_photos`, `studio_accounts`, `content_deliveries`,
`studio_instructors`, `clients`, plus the reels tables (`reel_edls`, `reel_hook_captures`,
`reel_music_library` — see *Reels*).

⚠️ **`reel_edls` is RLS deny-by-default**, so it is reachable only through the `service_role`
`reels.cjs` function. Everything else is readable by the browser under `authenticated` policies.
Measured 2026-08-07: the `studio_accounts` read is a **0.105 ms** seq scan (10 rows, 2 buffers) and
the SELECT policy's own lookups add **0.223 ms**. Nothing on this database is slow — if a query
appears to take seconds, the time is in connection setup or the network, not in Postgres.

RPCs called from this repo: `get_delivery_summaries(studio_id)` (delivery list without pulling
tens of MB of JSONB; falls back to a direct query) and `update_delivery_post_field`.

RLS is on everywhere and scopes by studio. **`service_role` switches RLS off by design**, so every
new function that uses it re-inherits the bypass and must hand-roll tenancy. Ask of any new
function: *why does this hold the master key?* If it can read as the caller, it should.

## n8n Workflows (`jmac.app.n8n.cloud`)

| Workflow | ID | Status |
|---|---|---|
| Main Content Generator | `pTTpsIlhtOYHqvXd` | Active |
| FCA AI Photo Generator | `nJ9eWDmfPA0TH8og` | Active |
| FCA Video Reel Generator | `t1xDbyCiad2oVJTM` | **Inactive but still called** — 404s every run |

⚠️ **Re-check API-write safety immediately before every n8n API write; never cache the assessment.**
Most of the fleet carries out-of-schema `settings` keys (`availableInMCP`, `binaryMode`) that make a
PUT either 400 or silently drop stored settings. `pTTpsIlhtOYHqvXd` is currently **UI-only**.
UI edits are two steps — save, then publish — then assert `versionId == activeVersionId`. A save
alone leaves the old version running while `active: true` says otherwise.

## Reels

Creatomate is gone. Current pipeline: **Claude** produces the edit decision list → **Shotstack**
renders → **Submagic** captions, orchestrated in n8n. Phase 3 cards and the 12% watermark shipped
2026-08-06.

### Data model

| Table | Shape |
|---|---|
| `reel_edls` | `reel_id`, `studio_id`, `status`, `edl` (jsonb), `render_status`, `render_url`, `render_error`, `render_id`, `render_submitted_at`, `created_at`, `updated_at` |
| `reel_hook_captures` | `capture_id`, `reel_id`, `studio_id`, `overlay_index`, `proposed_text`, `final_text`, `hook_edited`, `captured_at` |
| `reel_music_library` | Kevin MacLeod tracks (CC BY 4.0) by mood |

`reel_hook_captures` stores proposed vs final hook text with an `hook_edited` flag — the same
proposal-vs-published delta that `post_revisions` captures for captions. It is the voice-fidelity
signal for reels; don't treat it as an audit log and don't prune it.

### Why `reels.cjs` exists

**`public.reel_edls` is RLS deny-by-default** — no policy grants `authenticated` anything, so the
browser cannot read its own reels. `netlify/functions/reels.cjs` is a `service_role` function that
serves the Reels list and the approve/deliver actions. `service_role` bypasses RLS entirely, so
that function hand-rolls its tenancy: it re-reads `studio_id` off the row and compares before
mutating. Any new read/write path against `reel_edls` must do the same, via
`_authz.cjs requireStudioAccess(event, studioId, level)`.

### Creation is asynchronous by design

`NewReelModal` → `reel-create-background.js` returns **202 immediately** rather than blocking on a
sync-function timeout. n8n WF1 then persists a `pending_approval` row, which the Reels list
surfaces by polling. A reel that never appears means WF1 didn't write the row — look there, not at
the function.

⚠️ Shotstack posts **two different webhook types to one URL**; stills are blocked on disambiguating
them. Cards are gated on a logo that can carry alpha — a JPEG logo has no alpha and watermarks as
an opaque block.

## Pricing

Carried forward from the previous CLAUDE.md; not re-verified against Stripe in this rewrite.

- FCA Studio standard: $599/mo · $1,617/3mo · $5,750/yr
- Founding cohort (first 100, locked for life): $299/mo · $807/3mo · $2,870/yr
- All-in — no per-seat add-on. Founding rate is gated **server-side via `claim_founder_slot`**,
  automatic at signup. Not a coupon code; never bypass it with one.

## What Claude Code Must Never Do

- **Never commit a secret to this repo — it is public.** Never put a non-public value behind `VITE_`.
- **Never name a Netlify function `.js` if it requires a local module.** Use `.cjs`.
- **Never gate a brand-data write on `authReady`.** Use `studioLoaded`.
- **Never reintroduce `studioData` into `ADMIN_ACCOUNTS`.**
- **Never navigate to a `next` value that has not been through `nextPathFromQuery()`**, and never
  treat write-time validation as a substitute — the attacker mints the link, not us.
- **Never carry the post-login destination in `sessionStorage`, `localStorage`, or history state.**
  The URL is the only carrier that survives a mail client. Removed 2026-08-17; do not restore it.
- **Never add an in-app hop toward `/login` or `/forgot-password` without `withNext()`.**
- **Never delete or deactivate active n8n workflows**, especially `pTTpsIlhtOYHqvXd`.
- **Never modify webhook URLs** on active workflows — they take production traffic.
- **Never remove RLS policies.**
- **Never touch Supabase projects** `mtjqsjpgwiaacybyklkt` (HeardChef), `ruoovanjsycohnhugeku`
  (Amazon PPC), or `uceoibajdgabumsofzvx` (Lead Gen).
- **Never edit `legacy/`.** It is the retired SPA, kept for reference only.

## Working Conventions

- Run `npm test` and `npm run build` before pushing. Run `/review` before any `git push`.
- Playwright browser installs are unreliable on this Windows machine — prefer manual verification
  or the deployed-artifact checks below over automated browser QA.
- **Verify the artifact, not the intention.** After a deploy, fetch the built bundle from
  `app.fiorsaoirse.com` and grep for a string unique to the change. A 200 proves shape, never values.

## Session History

| Date | Changes |
|---|---|
| 2026-07-04 | BrandSettings secondary-colour persistence fix; corrected stale Supabase project ref |
| 2026-07-30 | Edit capture (`post_revisions`) live; health monitor armed |
| 2026-08-06 | Reel Phase 3 cards + watermark shipped; `.cjs` hotfix after ~2h `reels` outage |
| 2026-08-07 | `retryWithTimeout` on the `studio_accounts` read (5s → 8s); `studioLoaded` hydration gate replaces `authReady` in BrandSettings; failure-kind instrumentation (`studioLoadMs`, `studioLoadFailure`) so a client abort, an RLS-denied zero-row read and a real DB error stop sharing one log string; query timings measured; **this file rewritten** — prior version described an architecture that no longer existed |
| 2026-08-17 | **Session 1** — email deep link `/?id=` honoured and preserved through login (`lib/deepLink.js`, route allowlist), `884582a`; `test/deepLink.test.js` added at `1b58a8e` — the allowlist is a security boundary and shipped without committed tests, corrected same day. **Session 2** — destination moved off `sessionStorage` onto `?next=`, URL-borne end to end including the `/login` → `/forgot-password` hop where it would otherwise have died silently on the majority path (`aa812b5`, 77 tests, mutation-tested). **Supabase auth URL config fixed outside this repo** — Site URL and the Redirect URLs allowlist held only `studio-dash.netlify.app`, so every magic-link user authenticated on the wrong origin and stayed logged out on the custom domain; see *Auth Model → Origins*. This file's `sessionStorage` design description was stale within hours of being written and is now current |

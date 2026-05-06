# FCA Studio Dashboard — Project CLAUDE.md

> Read this at the start of every session. Do not skip it.

## What This Is
FCA (Fitness Content Agent) is an AI-powered social media content platform for boutique fitness studios. FCA Studio is $599/mo standard, with quarterly ($1,617/3mo, ~10% savings) and annual ($5,750/yr, ~20% savings) commitment options. The first 100 founding studios pay $299/mo, locked in for life — quarterly $807/3mo and annual $2,870/yr also available at founding rates. Founding pricing is automatic at signup based on availability; no coupon code required. The agent generates platform-specific social media posts, matches or generates photos, creates video reels, and delivers everything to a dashboard where owners and instructors review, edit, and approve content.

This repo (`admin625/studio-dashboard`) is the seller-facing dashboard — the primary UI for studio owners and instructors. It is a single-file vanilla JS SPA deployed on Netlify. All content generation happens in n8n workflows that write to Supabase; this dashboard reads and displays that data.

**Target users:** Boutique fitness studio owners (yoga, pilates, barre, cycling, HIIT, CrossFit, boxing, dance) and their instructors.

## Current Build State
Live at https://studio-dash.netlify.app
All core features built and deployed. One active paying client (Katie / TLK).

## Tech Stack
- **Frontend:** Vanilla JS SPA — single `index.html` (~2,450 lines, HTML + CSS + JS inline)
- **Database:** Supabase (`kidgcrqxrfcbsaeguwop`) — us-east-1
- **Hosting:** Netlify (studio-dash.netlify.app)
- **Content generation:** n8n Cloud (jmac.app.n8n.cloud) → Claude API → Supabase
- **AI photos:** Flux 2 Pro via BFL API (n8n)
- **Video reels:** Creatomate API (n8n)
- **AI text:** Anthropic Claude (via n8n, not called from dashboard directly)
- **Auth:** Supabase Auth (email/password, password reset)
- **Repo:** admin625/studio-dashboard

## Key Files
```
index.html          — Entire SPA (HTML + CSS + JS inline, ~2,450 lines)
assets/             — Static assets (logos, images)
netlify.toml        — Netlify config (publish: root, SPA redirect)
scripts/            — Utility scripts
CLAUDE.md           — This file
```
No build step. No framework. No bundler. Publish directory is root (`.`).

## Environment Variables
Supabase credentials are initialized directly in `index.html`:
```javascript
const SUPABASE_URL = '...'   // https://kidgcrqxrfcbsaeguwop.supabase.co
const SUPABASE_ANON = '...'  // anon key (client-safe)
```
No server-side secrets in this repo. All sensitive API calls (Claude, BFL, Creatomate) happen in n8n workflows, not in the dashboard.

## Supabase Schema (project: kidgcrqxrfcbsaeguwop)

### Tables

**content_deliveries** — generated content batches
- id, created_at, studio_id, client_id, instructor_email
- instagram_content, facebook_content, twitter_content, linkedin_content, tiktok_content (JSONB — array of post objects per platform)
- platform_content (JSONB — unified format used by newer code paths)
- video_url, video_status ('pending', 'rendering', 'ready', 'error'), video_render_id, video_error
- reel_script (JSONB — full reel scene data)

**studio_accounts** — studio settings and subscription
- id, studio_name, owner_email, owner_name
- plan_type ('studio_basic'), max_instructors (default 15)
- stripe_customer_id, stripe_subscription_id, subscription_status ('active'), subscription_id, paid_seats, subscription_started_at
- brand_color (default '#FF6B35')
- photo_source ('studio_only', 'ai_assist', 'ai_only' — default 'studio_only')
- ai_photo_prompt (text, nullable — per-studio direction for AI photo generation)
- ai_photos_enabled (legacy boolean, replaced by photo_source)
- referral_code, referral_credited_at
- created_at, updated_at

**studio_photos** — uploaded photo library
- id, studio_id, photo_url, file_name, keywords, tags (instructor emails for matching)
- Used by Smart Photo Matching in n8n

**studio_instructors** — instructor profiles
- id, studio_id, email, name, is_studio_instructor (boolean for role detection)

**clients** — studio client/account records
- id, studio_id, email, name

**reel_music_library** — background music for video reels
- 20 Kevin MacLeod tracks (CC BY 4.0), 5 per mood category
- Fields: title, artist, url, mood, duration, bpm

### RPC Functions
- `get_delivery_summaries(studio_id)` — returns delivery list with content counts without transferring 36MB of JSONB content. Fallback: direct query with LIMIT 50.
- `claim_founder_slot(...)` — server-side founding cohort gating. Determines whether a new signup qualifies for the founding rate ($299/mo) or pays standard ($599/mo). First-100 cap enforced atomically. Called at checkout — never bypass with coupon codes.

### RLS
Enabled on all tables. Queries are scoped by authenticated user's studio_id.

## Auth Model
Two roles, determined at login by querying `studio_instructors` and `studio_accounts`:
- **studio_owner** — sees everything: all deliveries, settings panel, photo source selector, AI photo prompt, freestyle mode toggle, generate content button
- **studio_instructor** — sees only their own deliveries, can edit captions/photos, no access to settings or freestyle mode

Role stored in `AppState.role`. Owner-only sections gated by `AppState.role === 'studio_owner'`.

## n8n Workflows (jmac.app.n8n.cloud)

| Workflow | ID | Status | Trigger |
|----------|-----|--------|---------|
| Main Content Generator | `pTTpsIlhtOYHqvXd` | Active | Dashboard webhook |
| FCA AI Photo Generator | `nJ9eWDmfPA0TH8og` | Active | `/webhook/fca-ai-photo` |
| FCA Video Reel Generator | `t1xDbyCiad2oVJTM` | Active | `/webhook/fca-video-reel` |
| DEACTIVATED duplicate | `tqOVZd7JPERcsidM` | Inactive | (was causing webhook conflicts, deactivated 2026-03-04) |

### Main Content Generator (36 nodes) — Full Flow
```
Webhook Trigger → Parse Form Data → Code in JavaScript (reset photo tracking)
  → Workflow Configuration → If → Merge with Get Client Data
  → Check Valid Studio → Check Trial Limits → Is Allowed?
    → allowed: Get Studio Instructors → Get Studio Photos → Build Premium Prompt
      → Generate Content with Claude → Parse Posts to Array → Smart Photo Matching
      → Split Posts by Platform → Save to Content Deliveries
        → Send Success Email + Update Trial Activity + Increment Posts Used
        → Prepare Reel AI Input → Generate Reel Script (Claude) → Parse & Enrich Reel
          → Get Reel Music → Assemble Reel Trigger → Trigger Video Reel V2 + Save Reel Script
      → Check Low Scores → Trigger AI Photo (for match_score < 10)
    → not allowed: Send Limit Reached Email
  → invalid: Send Rejection Email
```

### Photo Source Routing (added 2026-03-18)
Dashboard sends `photo_source` and `ai_photo_prompt` in the generation payload:
- `studio_only` → Smart Photo Matching runs, Check Low Scores returns [] (no AI ever)
- `ai_assist` → Smart Photo Matching runs, low scores trigger AI Photo (default behavior)
- `ai_only` → Smart Photo Matching skips entirely, all posts get needs_ai_image=true, all trigger AI Photo

`ai_photo_prompt` overrides the default fitness prompt in both Check Low Scores and Format Image Prompt nodes when present.

### Video Reel Renderer (v3, 2026-03-09)
- 1080x1920, 30fps, dynamic 7-9 scenes, 18-20s target duration
- Text in bottom 25%, gradient overlay (transparent top → 60% black bottom)
- Images: y:30% focal point, cover fit, per-scene animations
- CTA scene: 3-4s with brand color button + studio name + logo
- Music OFF by default (include_music field) — studios add Instagram audio post-publish
- reel_music_library: 20 Kevin MacLeod tracks (CC BY 4.0), 5 per mood

## Dashboard Features
- Login with Supabase Auth (owner + instructor roles, password reset)
- Delivery list view with summary counts (via `get_delivery_summaries` RPC, fallback direct query)
- Delivery detail view with per-platform post cards and format badges (feed post, story, thread)
- Inline caption and hashtag editing (saves to platform_content JSONB)
- Photo swap via photo editor with auto-save ("Saved" state feedback)
- Video reel player with status indicators (spinner while rendering, player when ready, error display)
- Generate Content modal:
  - Standard mode: brand voice, target audience, fitness focus, goal, mood, CTA, hashtags, themes, promotions
  - Freestyle mode (owner only): single textarea + 4 quick-start templates (event, instructor, transformation, seasonal)
  - Instagram sub-format selector (Feed Post, Story, Thread)
  - Per-generation photo direction field (pre-fills from studio setting, overridable)
  - Platforms + post count always visible in both modes
- Studio settings (owner only): photo source 3-way selector, AI photo prompt textarea with debounced auto-save, brand color
- Progress bar and step counter on delivery detail

## Stripe Integration
- **FCA Studio (standard):** $599/mo, $1,617/3mo (~10% savings), $5,750/yr (~20% savings)
- **FCA Studio (founding cohort, first 100 only):** $299/mo, $807/3mo, $2,870/yr — locked in for life
- **All-in pricing per HQ:** no per-seat add-on. The $299/$599 prices include all instructor seats.
- **Founding cohort routing:** gated server-side via the `claim_founder_slot` RPC, NOT a coupon code. Founding rate is automatic at signup based on availability — no code required, no manual coupon assignment.
- Stripe customer ID and subscription ID stored on studio_accounts
- Subscription status checked on login

## API Auth Patterns
- **BFL (Flux 2 Pro):** `x-key` header — NOT Bearer
- **Creatomate:** `Authorization: Bearer` prefix
- **Anthropic Claude:** via n8n (not called from dashboard)

## Active Clients
- Katie / TLK — brand_color: #5D7A7E (slate teal)

## Git Config
```
email: gurumcd@gmail.com
name: admin625
```

## What Claude Code Must Never Do
- **Never touch Supabase project `mtjqsjpgwiaacybyklkt`** (HeardChef) or `ruoovanjsycohnhugeku` (Amazon PPC) or `uceoibajdgabumsofzvx` (Lead Gen)
- **Never delete or deactivate active n8n workflows** — especially `pTTpsIlhtOYHqvXd` (Main Content Generator)
- **Never modify webhook URLs** on active workflows — they are live and receiving production traffic
- **Never remove RLS policies** — all tables are scoped by studio_id
- **Never hardcode API keys in index.html** — all sensitive calls go through n8n
- **Never introduce a build step** — this is a zero-dependency vanilla JS SPA and must stay that way
- **Never mix FCA tables with other product tables** — HeardChef tables were removed 2026-03-14, keep it clean

## n8n IF Node Fix Pattern
IF nodes imported from JSON may be missing `conditions.options` with `caseSensitive` and `typeValidation`. Fix by adding:
```json
"options": { "caseSensitive": true, "typeValidation": "strict", "version": 2, "leftValue": "" }
```
Auto-sanitization in n8n MCP handles this when any update is made via MCP.

## Session History
| Date | Changes |
|------|---------|
| 2026-03-04 | Video player, delivery RPC, auth rollback to stable baseline, deactivated duplicate workflow |
| 2026-03-09 | Freestyle mode, FREESTYLE_OWNERS_ONLY flag, delivery query optimization, video reel renderer v3 |
| 2026-03-14 | Inline editing for captions/hashtags, Instagram sub-format selector, format badges, HeardChef tables removed |
| 2026-03-18 | Photo source 3-way selector, AI photo prompt, Generate button fix, Save button fix, toggle/dropdown contrast, n8n workflow updated for photo_source routing |
| 2026-05-05 | CLAUDE.md pricing updated to canonical $299/$599 founding cohort routing (no per-seat add-on, server-side gating via `claim_founder_slot` RPC). |

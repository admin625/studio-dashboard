# FCA Studio Dashboard — Project CLAUDE.md

## What This Is
Seller-facing dashboard for the FCA (Fitness Content Agent) system. Studio owners and instructors log in to view generated social media content, edit captions and photos, generate new content batches, watch video reels, and manage studio settings. Single index.html SPA, vanilla JS, deployed on Netlify.

## Current Build State
Live at https://studio-dash.netlify.app
All core features built and deployed. Content generation flows through n8n workflows and lands in this dashboard for review/editing.

## Tech Stack
- Frontend: Vanilla JS SPA (single index.html, ~2400 lines)
- Database: Supabase (`kidgcrqxrfcbsaeguwop`) — us-east-1
- Hosting: Netlify (studio-dash.netlify.app)
- Content generation: n8n workflows → Supabase → dashboard reads
- AI photos: Flux 2 Pro (BFL API) via n8n
- Video reels: Creatomate via n8n
- Repo: admin625/studio-dashboard

## Key Files
```
index.html          — Entire SPA (HTML + CSS + JS inline, ~2400 lines)
assets/             — Static assets
netlify.toml        — Netlify config
scripts/            — Utility scripts
```

## Supabase Schema (project: kidgcrqxrfcbsaeguwop)
- **content_deliveries** — generated content batches (has video_url, video_status, video_render_id, video_error, reel_script, platform_content JSONB)
- **studio_photos** — uploaded studio photo library with keywords and tags
- **studio_accounts** — studio settings (brand_color, photo_source, ai_photo_prompt)
- **studio_instructors** — instructor profiles linked to studios
- **clients** — studio client/account records
- **reel_music_library** — 20 Kevin MacLeod tracks (CC BY 4.0), 5 per mood

## n8n Workflows (jmac.app.n8n.cloud)
| Workflow | ID | Webhook |
|----------|-----|---------|
| Main Content Generator | `pTTpsIlhtOYHqvXd` | (triggered from dashboard) |
| FCA AI Photo Generator | `nJ9eWDmfPA0TH8og` | `/webhook/fca-ai-photo` |
| FCA Video Reel Generator | `t1xDbyCiad2oVJTM` | `/webhook/fca-video-reel` |
| DEACTIVATED duplicate | `tqOVZd7JPERcsidM` | (was causing webhook conflicts) |

## Photo Source System (added 2026-03-18)
3-way selector replacing the old boolean AI toggle:
- `studio_only` — use studio photos only, never call AI
- `ai_assist` — studio photos first, AI fills gaps when match_score < 10
- `ai_only` — skip matching entirely, all AI-generated

`ai_photo_prompt` field on studio_accounts — per-studio direction for AI photo generation. Also overridable per-generation in the Generate Content modal.

## Content Generation Flow
1. Dashboard sends form data to n8n Main Content Generator webhook
2. n8n: Parse Form → Build Prompt → Claude generates posts → Smart Photo Matching → Split by Platform → Save to content_deliveries
3. After save: AI Reel Chain fires (Prepare → Generate Reel Script → Parse & Enrich → Get Music → Assemble → Trigger Video Reel)
4. After matching: Check Low Scores → Trigger AI Photo (for match_score < 10, respects photo_source setting)
5. Dashboard polls content_deliveries and displays results

## Key Dashboard Features
- Login with Supabase Auth (owner + instructor roles)
- Delivery list view with summary counts (uses `get_delivery_summaries` RPC)
- Delivery detail view with per-platform post cards
- Inline caption and hashtag editing (saves to platform_content JSONB)
- Photo swap via photo editor with auto-save
- Video reel player with status indicators (spinner/player/error)
- Generate Content modal with freestyle mode, Instagram sub-format selector
- Studio settings: photo source selector, AI photo prompt, brand color
- Format badges (feed post, story, thread) on delivery detail

## Git Config
- email: gurumcd@gmail.com
- name: admin625

## Critical Rules
- **Infrastructure isolation** — FCA Supabase project (`kidgcrqxrfcbsaeguwop`) is FCA only. HeardChef tables were removed 2026-03-14.
- **Single file SPA** — everything is in index.html. No build step, no framework, no bundler. Publish directory is root.
- **RLS active** — all Supabase queries are scoped by authenticated user
- **Video reel renderer specs** — 1080x1920, 30fps, 7-9 scenes, 18-20s, text in bottom 25%, music OFF by default
- **n8n IF node pattern** — IF nodes imported from JSON may need `conditions.options` with `caseSensitive` and `typeValidation`. Auto-sanitization in n8n MCP handles this.
- **BFL (Flux 2 Pro)** — uses `x-key` header, NOT Bearer
- **Creatomate** — uses `Authorization: Bearer` prefix

## APIs
- BFL (Flux 2 Pro): x-key header auth
- Creatomate: Bearer token auth
- Anthropic Claude: via n8n (content generation + reel scripts)

## Active Clients
- Katie / TLK — brand_color: #5D7A7E (slate teal)

## Session History
| Date | Changes |
|------|---------|
| 2026-03-04 | Video player, delivery RPC, auth rollback to stable baseline |
| 2026-03-09 | Freestyle mode, FREESTYLE_OWNERS_ONLY flag, delivery query optimization |
| 2026-03-14 | Inline editing, Instagram sub-format selector, format badges |
| 2026-03-18 | Photo source 3-way selector, AI photo prompt, Generate button fix, Save button fix, toggle/dropdown contrast |

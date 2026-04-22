# n8n Workflow Exports

**Source of truth for FCA n8n workflows.** Update on every workflow edit.

## Why this directory exists

n8n workflows live in the Cloud UI with no built-in version control. A workflow edited without a corresponding commit here is an untracked change — it can't be diffed, reviewed, reverted, or bisected when something breaks. On 2026-04-22 a silent 2026-04-17 edit broke the `FCA AI Photo Generator` (Nano storage host swapped without swapping the matching JWT); diagnosis took hours because no prior export existed to diff against. This directory prevents the next one.

## Ritual per workflow edit

1. Make the edit in n8n.
2. Export the workflow JSON (n8n UI `Download`, or the n8n MCP `n8n_get_workflow` with `mode: "full"`).
3. Sanitize before commit. Keep: `name`, `nodes`, `connections`, `settings`, `pinData`, `staticData`, `meta`, `tags` (names only). Drop: `id`, `createdAt`, `updatedAt`, `versionId`, `versionCounter`, `activeVersion*`, `shared`, `isArchived`, `triggerCount`, `active`. These are per-instance/runtime and create churn on every export without meaning.
4. **Credential check — load-bearing.** Every HTTP-style node must reference a named n8n credential by `{id, name}`. Do **not** inline `apikey`, `Authorization`, or any other secret-bearing header inside `parameters.headerParameters`. Inline secrets get committed as plaintext.
5. **Pre-commit grep — load-bearing.** Before every commit:
   ```bash
   grep -i eyJ workflows/*.json
   grep -iE '"value"[[:space:]]*:[[:space:]]*"(eyJ|sk-|ghp_|Bearer )' workflows/*.json
   ```
   The first must return **zero** matches (Supabase, Google, Anthropic, JWTs all start with `eyJ`). The second catches other common API-key prefixes and inline `Bearer` headers. If either matches, the commit must not land — move the secret into an n8n credential first, re-export, re-grep.
6. Commit with a descriptive message (`<workflow-name>: <what changed and why>`). One workflow per commit when possible — makes bisect usable.

## File naming

One file per workflow, kebab-case: `<workflow-name>.json`. The n8n-side workflow ID (e.g. `nJ9eWDmfPA0TH8og`) is **not** preserved here because it's instance-specific; the file name is the stable identifier.

## Current inventory

- `fca-ai-photo-generator.json` — production AI photo regeneration pipeline. Webhook trigger `POST /webhook/fca-ai-photo`. Routes to Flux2 / Kontext / Nano / Imagen4 branches. Uploads to `studio-photos` bucket on the default Supabase project (`kidgcrqxrfcbsaeguwop`) and writes a row to `studio_photos`. Credentials referenced: `Flux 2 API` (BFL `x-key` header) and `Supabase FCA Anon` (httpCustomAuth with both `apikey` and `Authorization` headers).

## Known follow-ups (not blockers for using this directory)

- The ritual above is currently manual. It belongs on the `/review` checklist so it's enforced, not remembered.
- `studio_photos` anon-INSERT RLS gap: the table's RLS only permits authenticated studio_owner inserts, so workflow rows don't land even when bucket uploads succeed. Image URLs are reachable; DB records aren't written. Pre-existing, captured 2026-04-22.
- A separate `fca-studio` Supabase project (`fidhmvuurygpknhshpml`) was created 2026-04-17 but never finished migrating into. Deciding to complete or decommission it is out of scope here — tracked elsewhere.

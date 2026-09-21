-- ⛔ SUPERSEDED the same day by 20260921200000_generation_outcome_rpc.sql, which drops this
-- policy (HQ item 3: too wide; instructors could read reviewer notes on the owner's runs).
--
-- Item 7, HQ 2026-09-21: studio members can read their studio's generation attempts, so
-- GenerateModal can poll the outcome of a run after the proxy's 202.
--
-- generation_attempts had RLS on and NO policies (deny-all to anon/authenticated). This adds
-- read-only access scoped by get_my_studio_ids(): the studio's clients rows (owner) plus its
-- ACTIVE instructors, because instructors generate from the same modal and their review
-- failures were as silent as the owner's. No insert, update or delete: only the generator
-- (service role) writes outcomes.
--
-- What becomes readable, within ONE studio (no cross-tenant exposure):
--   ids, counts, timings, n8n_execution_id, requested_params (platforms, photo_source,
--   studio_type, user_role and a freestyle true/false flag — not the freestyle text), outcome,
--   delivery_id, and outcome_detail, whose `notes` is the reviewer's free text about a draft
--   and can quote the draft. So an instructor can read the reviewer's notes on the owner's runs.
--   Accepted for now; the narrower alternative is an RPC that returns only
--   (outcome, outcome_detail, delivery_id) for a given client_request_id.
--
-- NOT `= any ((select public.get_my_studio_ids()))`: that compares uuid with uuid[] and fails
-- (42883). Applied 2026-09-21 (recorded as schema_migrations 20260921180200); verified as each
-- role: owner of 085fde09 sees 6 own / 0 other, owner of 948e26f4 the reverse, anon sees 0.
--
-- ROLLBACK ORDER (reverse of deploy): app → n8n generator → this policy → migration 150000.
-- Dropping this policy while the app is live turns every poll into zero rows ("no answer").

drop policy if exists generation_attempts_member_select on public.generation_attempts;
create policy generation_attempts_member_select
  on public.generation_attempts
  for select
  to authenticated
  using (studio_id in (select unnest(public.get_my_studio_ids())));

-- Item 7, HQ 2026-09-21: a studio member can read her studio's generation attempts, so
-- GenerateModal can poll the outcome of a run after the proxy's 202.
--
-- generation_attempts had RLS on and NO policies (deny-all to anon/authenticated). This adds
-- read-only access scoped by get_my_studio_ids() — the studio's clients rows (owner) plus its
-- ACTIVE instructors — because instructors generate from the same modal and their review
-- failures were as silent as the owner's. No insert, update or delete: only the generator
-- (service role) writes outcomes. The row holds no content: ids, counts, timings, the request's
-- platform/photo settings, and the outcome.

create policy generation_attempts_member_select
  on public.generation_attempts
  for select
  to authenticated
  using (studio_id in (select unnest(public.get_my_studio_ids())));
-- NOT `= any ((select public.get_my_studio_ids()))`: that compares uuid with uuid[] and fails
-- (42883). Applied 2026-09-21; verified as each role: owner of 085fde09 sees 6/0, owner of
-- 948e26f4 sees 0/6 the other way round, anon sees 0.

-- WO-2b pass 4 prerequisites. Applied via Supabase MCP 2026-09-04; committed here to keep the
-- migrations directory the record of what the database actually is.
--
-- 1. 'planning' is a real quarter state. The planner returns 202 immediately and the row exists,
--    unfilled, while Opus works. Without it the row would sit in 'draft' while it is not yet a
--    draft, and the dashboard could not tell "being planned" from "ready to read".
alter table public.calendar_quarters drop constraint calendar_quarters_status_check;
alter table public.calendar_quarters add constraint calendar_quarters_status_check
  check (status in ('planning','draft','owner_reviewed','active','closed'));

-- 2. modality_strategies.source — provenance for goal weights. Additive, nullable.
--    The weights are the OWNER's target. The planner reads this table and never writes it:
--    a planner that sets its own target cannot drift against it, which is exactly what made the
--    first TLK run's quarter_coverage meaningless (drift was near zero by construction).
alter table public.modality_strategies add column if not exists source text;
comment on column public.modality_strategies.source is
  'Provenance of goal_weights. hq_default_pending_owner_confirm = seeded by HQ, NOT yet confirmed by the studio owner. The planner reads this table and never writes it.';

-- 3. Clear the first TLK Q4 draft (cascades to weeks, slots, and the planner-written strategy row).
delete from public.calendar_quarters
where studio_id = '948e26f4-5996-4e11-9b86-c89664b0e600'
  and quarter_start = '2026-10-01';

-- 4. Seed the quarter shell and the owner-side weights, in that order (strategies FK the quarter).
insert into public.calendar_quarters (studio_id, quarter_start, quarter_end, status)
values ('948e26f4-5996-4e11-9b86-c89664b0e600','2026-10-01','2026-12-31','planning');

insert into public.modality_strategies (studio_id, modality_id, quarter_id, goal_weights, source)
select '948e26f4-5996-4e11-9b86-c89664b0e600', null, q.id,
       '{"awareness":0.45,"class_traffic":0.35,"event_conversion":0.20,"other":0.00}'::jsonb,
       'hq_default_pending_owner_confirm'
from public.calendar_quarters q
where q.studio_id = '948e26f4-5996-4e11-9b86-c89664b0e600' and q.quarter_start = '2026-10-01';

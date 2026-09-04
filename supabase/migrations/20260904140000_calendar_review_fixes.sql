-- Content Calendar — WO-2a review fixes. Authorized by HQ 2026-09-04.
-- Closes the three informational findings from the WO-2a /review pass.
--
-- FIX 1 — job vocabulary gets a single source of truth (calendar_jobs).
--   quarter_coverage hard-coded the four job values in a VALUES list that duplicated the
--   calendar_slots.job CHECK. Deriving the list from the CHECK at runtime means regex-parsing
--   pg_get_constraintdef() inside a production view — live, but it breaks the moment the
--   constraint is rewritten in an equivalent form. A reference table is the relational answer:
--   one row per job, FK from calendar_slots, view joins it, and adding a job is an INSERT
--   instead of DDL in three places.
--
--   RESIDUAL COUPLING, RECORDED NOT HIDDEN: calendar_goal_weights_valid() still names the four
--   jobs literally. It cannot read calendar_jobs — a CHECK constraint requires an IMMUTABLE
--   function, and an IMMUTABLE function may not read tables. Adding a fifth job therefore still
--   requires editing that function. This is a Postgres constraint, not an oversight; the comment
--   on calendar_jobs says so at the place someone will actually look.
--
-- FIX 2 — calendar_week_repoints is specced insert-only (v1.0 §3.6). Its UPDATE policy came from
--   the loop that built all nine tables uniformly. Dropped.
--
-- FIX 3 — RLS hoisting. THE LITERAL FIX DOES NOT WORK, SO A WORKING ONE IS APPLIED INSTEAD.
--   The instruction was to wrap the call as (select is_studio_owner(studio_id)). Supabase's
--   InitPlan pattern hoists a subquery only when it is UNCORRELATED: (select auth.uid()) has no
--   row-dependent argument, so the planner evaluates it once. is_studio_owner(studio_id) takes
--   the ROW's studio_id, so wrapping it in (select ...) leaves it correlated and it still runs
--   per row. It would look like the documented fix and change nothing measurable.
--
--   What actually hoists: a set-returning companion with NO arguments.
--     using (studio_id in (select public.owned_studio_ids()))
--   That subquery is uncorrelated, so it becomes an InitPlan evaluated once per statement.
--   is_studio_owner(uuid) is KEPT and unchanged — v1.1 §6 calls it as an RPC from the route guard
--   and §8.7 makes it the helper every future owner-only surface uses. Two entry points, one
--   definition of ownership: the scalar for "is this caller the owner of THAT studio", the set for
--   "which studios does this caller own", which is the shape a row filter needs.

-- ---------- FIX 1: calendar_jobs ----------
create table public.calendar_jobs (
  job        text primary key,
  sort_order int  not null,
  created_at timestamptz not null default now()
);
comment on table public.calendar_jobs is
  'Job vocabulary for calendar_slots.job and modality_strategies.goal_weights keys. Single source '
  'of truth; quarter_coverage joins this table. NOTE: adding a row here also requires editing '
  'calendar_goal_weights_valid(), which names the jobs literally because a CHECK constraint '
  'requires an IMMUTABLE function and an IMMUTABLE function may not read tables.';

insert into public.calendar_jobs (job, sort_order) values
  ('awareness',1), ('class_traffic',2), ('event_conversion',3), ('other',4);

alter table public.calendar_slots drop constraint calendar_slots_job_check;
alter table public.calendar_slots
  add constraint calendar_slots_job_fkey foreign key (job) references public.calendar_jobs(job);

-- ---------- FIX 3: the companion that actually hoists ----------
create or replace function public.owned_studio_ids()
returns setof uuid language sql security definer stable set search_path = public as $fn$
  select s.id from studio_accounts s
  where lower(s.owner_email) = lower(coalesce(auth.jwt() ->> 'email', ''));
$fn$;

revoke all     on function public.owned_studio_ids() from public;
revoke execute on function public.owned_studio_ids() from anon, authenticated;
grant  execute on function public.owned_studio_ids() to authenticated;

-- ---------- Rebuild every policy on the hoisted predicate ----------
do $rls$
declare t text;
begin
  foreach t in array array['calendar_studio_profile','studio_modalities','calendar_quarters',
                           'modality_strategies','calendar_weeks','calendar_week_repoints',
                           'partners','program_entries','calendar_slots']
  loop
    execute format('drop policy if exists %I on public.%I', t||'_owner_select', t);
    execute format('drop policy if exists %I on public.%I', t||'_owner_insert', t);
    execute format('drop policy if exists %I on public.%I', t||'_owner_update', t);

    execute format('create policy %I on public.%I for select to authenticated using (studio_id in (select public.owned_studio_ids()))', t||'_owner_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (studio_id in (select public.owned_studio_ids()))', t||'_owner_insert', t);

    -- FIX 2: calendar_week_repoints is insert-only. No update policy.
    if t <> 'calendar_week_repoints' then
      execute format('create policy %I on public.%I for update to authenticated using (studio_id in (select public.owned_studio_ids())) with check (studio_id in (select public.owned_studio_ids()))', t||'_owner_update', t);
    end if;
  end loop;
end
$rls$;

drop policy if exists program_entry_partners_owner_select on public.program_entry_partners;
drop policy if exists program_entry_partners_owner_insert on public.program_entry_partners;
create policy program_entry_partners_owner_select on public.program_entry_partners
  for select to authenticated using (exists (
    select 1 from public.program_entries pe
    where pe.id = program_entry_id and pe.studio_id in (select public.owned_studio_ids())));
create policy program_entry_partners_owner_insert on public.program_entry_partners
  for insert to authenticated with check (exists (
    select 1 from public.program_entries pe
    where pe.id = program_entry_id and pe.studio_id in (select public.owned_studio_ids())));

-- calendar_jobs is shared vocabulary, not studio data: readable by any authenticated caller,
-- writable by none of them.
alter table public.calendar_jobs enable row level security;
alter table public.calendar_jobs force  row level security;
create policy calendar_jobs_read on public.calendar_jobs
  for select to authenticated using (true);
revoke all    on public.calendar_jobs from anon;
grant  select on public.calendar_jobs to authenticated;

-- ---------- FIX 1: quarter_coverage joins calendar_jobs ----------
drop view if exists public.quarter_coverage;
create view public.quarter_coverage with (security_invoker = true) as
with brand as (
  select quarter_id, goal_weights from public.modality_strategies where modality_id is null
),
fallback as (
  select quarter_id, jsonb_object_agg(k, v) as gw from (
    select quarter_id, k, avg(v::numeric) as v
    from public.modality_strategies ms, lateral jsonb_each_text(ms.goal_weights) as e(k,v)
    where ms.modality_id is not null
    group by quarter_id, k
  ) z group by quarter_id
),
counted as (
  select q.id as quarter_id, q.studio_id, q.drift_threshold, j.job, j.sort_order,
         coalesce((b.goal_weights->>j.job)::numeric, (f.gw->>j.job)::numeric, 0) as intended_share,
         coalesce(
           (select count(*) from public.calendar_slots s
             where s.quarter_id = q.id and s.status <> 'superseded' and s.job = j.job)::numeric
           / nullif((select count(*) from public.calendar_slots s2
             where s2.quarter_id = q.id and s2.status <> 'superseded'), 0), 0) as pointed_share
  from public.calendar_quarters q
  cross join public.calendar_jobs j
  left join brand    b on b.quarter_id = q.id
  left join fallback f on f.quarter_id = q.id
)
select quarter_id, studio_id, job, intended_share, pointed_share,
       pointed_share - intended_share as drift,
       abs(pointed_share - intended_share) > drift_threshold as over_threshold
from counted
order by quarter_id, sort_order;

revoke all   on public.quarter_coverage from anon;
grant select on public.quarter_coverage to authenticated;

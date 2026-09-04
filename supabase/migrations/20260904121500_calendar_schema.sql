-- Content Calendar WO-2a step 2 — §3.1–§3.9 schema, §3.10 posts reference, §3.11 RLS.
-- Spec: build-spec-v1.1 §3. §3.1–§3.9 are carried by reference from v1.0, committed a87fb78.
--
-- HQ RULING RECORDED — §3.7 calendar_slots.post_id IS STRUCK.
-- v1.0 §3.7 defined post_id uuid -> "posts table (WO-1 item 1 names it)"; v1.1 §3.10 defines the
-- reference in the opposite direction. Building both is a bidirectional FK pair: two rows to keep
-- in sync, an insert-order problem, and two places that can disagree about which post filled which
-- slot. One direction only — generation_posts.slot_id is the queryable reference (2.18, §3.10).
-- slot -> post is recoverable by query.
--
-- §3.10 RESOLVED BY RULE, NOT AT THE KEYBOARD — REUSE both live columns:
--   generation_posts.slot_id  uuid, nullable, 0 non-null of 8 rows -> reuse; add FK + index.
--   generation_posts.purpose  text, nullable, 0 non-null of 8 rows -> reuse as the reader-facing
--                             mirror of calendar_slots.job (also text). Generator writes it (WO-2c).
--   ZERO-READER GREP RESULT: zero readers. No generation_posts.slot_id / .purpose reference in
--   studio-dashboard/src, studio-dashboard/netlify/functions, or ANY workflow in the
--   backups/n8n/2026-09-04 snapshot. The four "purpose" hits in the dashboard are English prose in
--   code comments, not column reads. No rename, no parallel column. Acceptance 12 holds: exactly
--   one slot_id column on generation_posts after this migration.
--
-- program_entry_partners carries no studio_id (v1.0 §3.8 defines it as a bare junction), so its
-- RLS resolves the SAME predicate through its parent rather than denormalising a studio_id onto
-- it. The mechanism differs; the predicate does not. Recorded rather than silently chosen.

-- ---------- §3.1 calendar_studio_profile ----------
create table public.calendar_studio_profile (
  studio_id           uuid primary key references public.studio_accounts(id) on delete cascade,
  purpose             text,
  audience_exclusions text[],   -- '{}' = asked, none;  null = unasked (affirmed-empty convention)
  capture_constraints text[],
  cadence_per_week    int,
  soft_slots          jsonb,
  seasonality_priors  jsonb,    -- [{claim, asserted_at, verified:false}]; weighting only, never rationale (§5.3)
  updated_at          timestamptz not null default now()
);

-- ---------- §3.2 studio_modalities ----------
create table public.studio_modalities (
  id         uuid primary key default gen_random_uuid(),
  studio_id  uuid not null references public.studio_accounts(id) on delete cascade,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index studio_modalities_studio_lower_name_key
  on public.studio_modalities (studio_id, lower(name));

-- ---------- §3.4 calendar_quarters (declared before §3.3: strategies reference it) ----------
create table public.calendar_quarters (
  id                uuid primary key default gen_random_uuid(),
  studio_id         uuid not null references public.studio_accounts(id) on delete cascade,
  quarter_start     date not null,
  quarter_end       date not null,
  arc_text          text,
  drift_threshold   numeric(3,2) not null default 0.20,
  status            text not null default 'draft'
                    check (status in ('draft','owner_reviewed','active','closed')),
  generated_at      timestamptz,
  generation_model  text,
  generation_tokens int,
  created_at        timestamptz not null default now(),
  unique (studio_id, quarter_start)
);

-- §3.3 goal_weights must sum to 1 across the four jobs ("check constraint via a function")
create or replace function public.calendar_goal_weights_valid(w jsonb)
returns boolean language sql immutable as $fn$
  select w ?& array['awareness','class_traffic','event_conversion','other']
     and abs( coalesce((w->>'awareness')::numeric,0)
            + coalesce((w->>'class_traffic')::numeric,0)
            + coalesce((w->>'event_conversion')::numeric,0)
            + coalesce((w->>'other')::numeric,0) - 1 ) < 0.001;
$fn$;

-- ---------- §3.3 modality_strategies ----------
create table public.modality_strategies (
  id           uuid primary key default gen_random_uuid(),
  studio_id    uuid not null references public.studio_accounts(id) on delete cascade,
  modality_id  uuid references public.studio_modalities(id) on delete cascade,  -- nullable = brand-level
  quarter_id   uuid not null references public.calendar_quarters(id) on delete cascade,
  goal_weights jsonb not null check (public.calendar_goal_weights_valid(goal_weights)),
  situation    text,   -- owner-stated; MAY NOT surface in rationale (§5.3)
  priors       jsonb,
  created_at   timestamptz not null default now()
);

-- ---------- §3.5 calendar_weeks ----------
create table public.calendar_weeks (
  id                uuid primary key default gen_random_uuid(),
  quarter_id        uuid not null references public.calendar_quarters(id) on delete cascade,
  studio_id         uuid not null references public.studio_accounts(id) on delete cascade,
  week_start        date not null,
  planned_jobs      jsonb,
  current_jobs      jsonb,
  repoint_count     int not null default 0,
  last_repointed_at timestamptz,
  created_at        timestamptz not null default now(),
  unique (quarter_id, week_start)
);

-- ---------- §3.6 calendar_week_repoints (insert-only signal log) ----------
create table public.calendar_week_repoints (
  id                       uuid primary key default gen_random_uuid(),
  week_id                  uuid not null references public.calendar_weeks(id) on delete cascade,
  studio_id                uuid not null references public.studio_accounts(id) on delete cascade,
  from_jobs                jsonb,
  to_jobs                  jsonb,
  reason                   text,
  repointed_at             timestamptz not null default now(),
  rationale_regenerated_at timestamptz
);

-- ---------- §3.8 program inventory ----------
create table public.partners (
  id         uuid primary key default gen_random_uuid(),
  studio_id  uuid not null references public.studio_accounts(id) on delete cascade,
  name       text not null,
  kind       text,
  created_at timestamptz not null default now(),
  unique (studio_id, name)
);

create table public.program_entries (
  id                    uuid primary key default gen_random_uuid(),
  studio_id             uuid not null references public.studio_accounts(id) on delete cascade,
  program               text not null check (program in ('konnect','events')),
  title                 text,
  topic                 text,
  guest_name            text,
  date_precision        text not null check (date_precision in ('confirmed','month','tbd')),
  event_date            date,
  event_month           date,
  confirmation_status   text not null default 'unconfirmed'
                        check (confirmation_status in ('confirmed','unconfirmed')),
  participants_complete boolean not null default false,
  manual_hold           boolean not null default false,
  hold_reason           text,
  hold_released_at      timestamptz,
  hold_released_by      text,
  notes                 text,
  created_at            timestamptz not null default now(),
  constraint program_entries_confirmed_needs_date
    check (date_precision <> 'confirmed' or event_date  is not null),
  constraint program_entries_month_needs_month
    check (date_precision <> 'month'     or event_month is not null)
);

-- Konnect! and Events are one table with a discriminator, not a flattened event list.
create table public.program_entry_partners (
  program_entry_id uuid not null references public.program_entries(id) on delete cascade,
  partner_id       uuid not null references public.partners(id) on delete cascade,
  primary key (program_entry_id, partner_id)
);

-- ---------- §3.7 calendar_slots ----------
create table public.calendar_slots (
  id                     uuid primary key default gen_random_uuid(),
  studio_id              uuid not null references public.studio_accounts(id) on delete cascade,
  week_id                uuid not null references public.calendar_weeks(id) on delete cascade,
  quarter_id             uuid not null references public.calendar_quarters(id) on delete cascade,
  slot_date              date,
  soft_slot              text,
  job                    text not null check (job in ('awareness','class_traffic','event_conversion','other')),
  job_other              text,
  audience               text not null check (audience in ('own','partner','cold')),
  modality_id            uuid references public.studio_modalities(id),
  program_entry_id       uuid references public.program_entries(id),
  rationale              text not null,
  rationale_goal_level   text check (rationale_goal_level in ('week','month','quarter')),
  rationale_model        text,
  rationale_generated_at timestamptz,
  -- 'held' = §5.2 guard active; 'superseded' = a re-point replaced it (rows are never deleted,
  -- so the quarter's intent history stays queryable)
  status                 text not null default 'planned'
                         check (status in ('planned','held','generated','superseded')),
  created_at             timestamptz not null default now(),
  -- post_id STRUCK per HQ ruling above; generation_posts.slot_id is the reference (§3.10)
  constraint calendar_slots_job_other_required check (job <> 'other' or job_other is not null)
);
create index calendar_slots_quarter_status_idx on public.calendar_slots (quarter_id, status);
create index calendar_slots_week_idx           on public.calendar_slots (week_id);

-- ---------- §3.10 generation_posts — REUSE the live columns, in place ----------
alter table public.generation_posts
  add constraint generation_posts_slot_id_fkey
  foreign key (slot_id) references public.calendar_slots(id) on delete set null;
create index generation_posts_slot_id_idx on public.generation_posts (slot_id);
comment on column public.generation_posts.slot_id is
  'Calendar slot this post filled. Null = owner-initiated (build-spec v1.1 §0.2/§3.10).';
comment on column public.generation_posts.purpose is
  'Reader-facing mirror of calendar_slots.job, written by the generator from the slot (§3.10).';

-- ---------- §3.9 quarter_coverage view ----------
create view public.quarter_coverage with (security_invoker = true) as
with jobs(job) as (values ('awareness'),('class_traffic'),('event_conversion'),('other')),
brand as (
  select quarter_id, goal_weights from public.modality_strategies where modality_id is null
),
fallback as (
  select quarter_id, jsonb_build_object(
      'awareness',        avg(coalesce((goal_weights->>'awareness')::numeric,0)),
      'class_traffic',    avg(coalesce((goal_weights->>'class_traffic')::numeric,0)),
      'event_conversion', avg(coalesce((goal_weights->>'event_conversion')::numeric,0)),
      'other',            avg(coalesce((goal_weights->>'other')::numeric,0))
    ) as gw
  from public.modality_strategies where modality_id is not null group by quarter_id
),
counted as (
  select q.id as quarter_id, q.studio_id, q.drift_threshold, j.job,
         coalesce((b.goal_weights->>j.job)::numeric, (f.gw->>j.job)::numeric, 0) as intended_share,
         coalesce(
           (select count(*) from public.calendar_slots s
             where s.quarter_id = q.id and s.status <> 'superseded' and s.job = j.job)::numeric
           / nullif((select count(*) from public.calendar_slots s2
             where s2.quarter_id = q.id and s2.status <> 'superseded'), 0), 0) as pointed_share
  from public.calendar_quarters q
  cross join jobs j
  left join brand    b on b.quarter_id = q.id
  left join fallback f on f.quarter_id = q.id
)
select quarter_id, studio_id, job, intended_share, pointed_share,
       pointed_share - intended_share as drift,
       abs(pointed_share - intended_share) > drift_threshold as over_threshold
from counted;

-- ---------- §3.11 RLS — owner only; no delete policy, no instructor policy ----------
do $rls$
declare t text;
begin
  foreach t in array array['calendar_studio_profile','studio_modalities','calendar_quarters',
                           'modality_strategies','calendar_weeks','calendar_week_repoints',
                           'partners','program_entries','calendar_slots']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_studio_owner(studio_id))', t||'_owner_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_studio_owner(studio_id))', t||'_owner_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_studio_owner(studio_id)) with check (public.is_studio_owner(studio_id))', t||'_owner_update', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end
$rls$;

-- junction: same predicate, resolved through its parent (no studio_id column, by spec)
alter table public.program_entry_partners enable row level security;
alter table public.program_entry_partners force  row level security;
create policy program_entry_partners_owner_select on public.program_entry_partners
  for select to authenticated using (exists (
    select 1 from public.program_entries pe
    where pe.id = program_entry_id and public.is_studio_owner(pe.studio_id)));
create policy program_entry_partners_owner_insert on public.program_entry_partners
  for insert to authenticated with check (exists (
    select 1 from public.program_entries pe
    where pe.id = program_entry_id and public.is_studio_owner(pe.studio_id)));
revoke all on public.program_entry_partners from anon;
grant select, insert, update on public.program_entry_partners to authenticated;

revoke all   on public.quarter_coverage from anon;
grant select on public.quarter_coverage to authenticated;

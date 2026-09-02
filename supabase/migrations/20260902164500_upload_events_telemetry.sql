-- 20260902164500_upload_events_telemetry.sql
-- WO-2 phase 2, sub-session 2a. FAR spec v0.3 §7 column set + §6 stage vocabulary.
--
-- Brings public.upload_events from the shape it shipped with on 2026-08-20 (f95297c) to the
-- §7 required set, and adds reel_upload_chain — one row per upload attempt, joined to
-- reel_edls so an attempt that uploaded clips but never produced an EDL is visible as a row
-- rather than as an absence nobody queries for.
--
-- Deliberately UNTOUCHED and never written by new code: event_type, file_name, bytes_sent,
-- error. They are load-bearing for the existing emitter and carry a different vocabulary
-- from the §7 fields that superficially resemble them (bytes_sent is cumulative across an
-- attempt, not per-object; file_name is the local picker name, not storage_path).

begin;

-- 1. DDL on existing columns (3).
-- auth_user_id: NOT NULL + default auth.uid() made a server_fn emitter impossible — under
-- service_role auth.uid() is NULL, so the insert failed the constraint, not the policy.
alter table public.upload_events alter column auth_user_id drop not null;
-- source: a server_fn row that omitted it was silently relabelled 'client' rather than rejected.
alter table public.upload_events alter column source drop default;
-- occurred_at: default now() meant a client that failed to stamp its own time got a SERVER
-- timestamp in the client column, indistinguishable from a real one.
alter table public.upload_events alter column occurred_at drop default;

-- 2. Add the §7 columns (8).
-- outcome is added nullable, backfilled, then constrained: the table already holds rows, so
-- a bare NOT NULL add would fail. Backfill derives from the existing event_type vocabulary.
alter table public.upload_events
  add column if not exists outcome        text,
  add column if not exists storage_bucket text,
  add column if not exists storage_path   text,
  add column if not exists observed_bytes bigint,
  add column if not exists http_status    integer,
  add column if not exists error_code     text,
  add column if not exists error_message  text,
  add column if not exists payload        jsonb not null default '{}'::jsonb;

update public.upload_events
   set outcome = case when event_type = 'upload_failed' then 'fail' else 'ok' end
 where outcome is null;

alter table public.upload_events alter column outcome set not null;
alter table public.upload_events
  add constraint upload_events_outcome_check check (outcome in ('ok','fail'));

-- 3. Indexes (3).
create index if not exists upload_events_attempt_created_idx
  on public.upload_events (attempt_id, created_at);
create index if not exists upload_events_studio_created_idx
  on public.upload_events (studio_id, created_at desc);
create index if not exists upload_events_reel_idx
  on public.upload_events (reel_id);

-- 4. RLS. The client INSERT policy carried only (auth.uid() IS NOT NULL) — any authenticated
-- session could write a row bearing ANY studio_id. Scoped to the caller's own studios, with
-- NULL allowed so a pre-session event (file_selected before studio context resolves) can land.
-- upload_events_select_own_studio is REPORTED, NOT REMOVED, per the work order.
drop policy if exists upload_events_insert_authenticated on public.upload_events;
create policy upload_events_insert_authenticated
  on public.upload_events for insert to authenticated
  with check (studio_id is null or studio_id = any (get_my_studio_ids()));

-- 5. reel_upload_chain. Join key is r.reel_id — reel_edls PK is reel_id, confirmed in step 0.
create or replace view reel_upload_chain as
select e.attempt_id, e.studio_id, e.reel_id,
       max(e.payload->>'surface') filter (where e.stage='file_selected')                 as surface,
       max(e.created_at)                                                                  as last_ts,
       (array_agg(e.stage      order by e.created_at desc) filter (where e.outcome='ok'))[1]   as last_ok_stage,
       (array_agg(e.stage      order by e.created_at asc)  filter (where e.outcome='fail'))[1] as first_fail_stage,
       (array_agg(e.error_code order by e.created_at asc)  filter (where e.outcome='fail'))[1] as first_error,
       bool_or(e.stage='wf1_triggered' and e.outcome='ok' and e.http_status=200)              as wf1_ok,
       (r.reel_id is not null)                                                                as edl_row_present
from upload_events e
left join reel_edls r on r.reel_id = e.reel_id
group by e.attempt_id, e.studio_id, e.reel_id, r.reel_id;

-- The view joins reel_edls, which is RLS deny-by-default. A view runs with its OWNER's
-- privileges unless told otherwise, and Supabase grants SELECT on new public objects to
-- anon/authenticated by default — so left as-is this view would hand every authenticated
-- session the full cross-studio upload chain, including which reels have EDL rows.
-- REVOKE FROM PUBLIC alone does not strip Supabase's default grants; the named roles must be
-- revoked explicitly.
revoke all on reel_upload_chain from public;
revoke all on reel_upload_chain from anon, authenticated;
grant select on reel_upload_chain to service_role;

commit;

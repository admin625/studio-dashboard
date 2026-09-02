-- 20260902181500_reel_upload_chain_regroup.sql
-- WO-2 phase 2, sub-session 2c.
--
-- reel_upload_chain grouped by (attempt_id, studio_id, reel_id, r.reel_id). file_selected is
-- emitted at the picker, BEFORE a reel_id exists, so every attempt split into two rows: a
-- phantom half with reel_id NULL carrying last_ok_stage='file_selected', wf1_ok=false,
-- edl_row_present=false, sitting beside the real row that says wf1_ok=true.
--
-- Observed 2026-09-02 on live rows: attempt a7eb4347 and attempt 6f390974 each appeared
-- twice, and in both cases the phantom row read as a failure. Anyone asking the view "did
-- this attempt succeed" got a row saying no. The chain is keyed by ATTEMPT — that is what
-- correlation_id means — so reel_id must be aggregated, not grouped by.
--
-- reel_id is taken as the latest non-NULL value for the attempt, via the same array_agg()
-- filter idiom the view already uses. NOT max(): Postgres has no max(uuid), which the first
-- apply attempt discovered. One attempt mints exactly one reel_id and the rows that predate
-- it carry NULL, so the filtered pick is exact rather than merely arbitrary.
--
-- Grants are deliberately re-applied. CREATE OR REPLACE VIEW preserves them, but Supabase
-- grants SELECT on public objects to anon/authenticated by default and this view joins
-- reel_edls (RLS deny-by-default); re-asserting costs nothing and makes the intent explicit
-- rather than dependent on remembering that REPLACE happens not to reset them.

begin;

create or replace view reel_upload_chain as
select e.attempt_id,
       e.studio_id,
       (array_agg(e.reel_id order by e.created_at desc) filter (where e.reel_id is not null))[1] as reel_id,
       max(e.payload->>'surface') filter (where e.stage='file_selected')                  as surface,
       max(e.created_at)                                                                  as last_ts,
       (array_agg(e.stage      order by e.created_at desc) filter (where e.outcome='ok'))[1]   as last_ok_stage,
       (array_agg(e.stage      order by e.created_at asc)  filter (where e.outcome='fail'))[1] as first_fail_stage,
       (array_agg(e.error_code order by e.created_at asc)  filter (where e.outcome='fail'))[1] as first_error,
       bool_or(e.stage='wf1_triggered' and e.outcome='ok' and e.http_status=200)              as wf1_ok,
       bool_or(r.reel_id is not null)                                                         as edl_row_present
from upload_events e
left join reel_edls r on r.reel_id = e.reel_id
group by e.attempt_id, e.studio_id;

revoke all on reel_upload_chain from public;
revoke all on reel_upload_chain from anon, authenticated;
grant select on reel_upload_chain to service_role;

commit;

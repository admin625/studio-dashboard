-- 20260902174500_upload_events_fail_index.sql
-- WO-2 phase 2, sub-session 2b, step 6b. Rides with the emitter commit, deliberately.
--
-- upload_events_failures_idx was partial on event_type = 'upload_failed'. That value is
-- legacy: from this commit forward the emitter writes {stage}_fail, so the old index stays
-- perfectly valid, perfectly empty of new rows, and perfectly misleading — anything built on
-- it reads clean while failures accumulate beside it. Nothing errors. That is the shape of a
-- gate that outlived its reason, and the rule is to retire it in the SAME change as the fix
-- rather than leave a monitor that cannot fire.
--
-- Replaced with a partial index on the column that now carries the meaning: outcome='fail'.
-- Ordered by created_at (server arrival) because that is what a "recent failures" query
-- scans; occurred_at is client-stamped and can be replayed out of order by the queue.

begin;

drop index if exists public.upload_events_failures_idx;

create index if not exists upload_events_fail_idx
  on public.upload_events (created_at desc)
  where outcome = 'fail';

commit;

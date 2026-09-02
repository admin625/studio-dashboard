-- 20260902170000_event_type_widen.sql
-- WO-2 phase 2, sub-session 2b, step 1.
--
-- upload_events.event_type is NOT NULL, has no default, and was constrained to exactly four
-- legacy names. That constraint is why the §6 stage vocabulary cannot simply replace it: any
-- emitter writing a fifth value is rejected at insert. Widen the constraint so event_type can
-- carry the derived {stage}_{outcome} form alongside the four legacy values already on disk.
--
-- 20 permitted values: 4 legacy + (8 §6 stages x 2 outcomes).
--
-- The legacy four are retained deliberately, not for new writes. Two rows written on
-- 2026-08-20 already carry upload_started and upload_failed; dropping those values from the
-- constraint would make the existing table fail its own check.

begin;

alter table public.upload_events
  drop constraint if exists upload_events_event_type_check;

alter table public.upload_events
  add constraint upload_events_event_type_check check (event_type in (
    -- legacy (pre-2b, retained so existing rows remain valid; not written by new code)
    'upload_started',
    'upload_progress',
    'upload_completed',
    'upload_failed',
    -- §6 stage x outcome
    'file_selected_ok',            'file_selected_fail',
    'session_checked_ok',          'session_checked_fail',
    'transmit_started_ok',         'transmit_started_fail',
    'transmit_completed_ok',       'transmit_completed_fail',
    'transmit_abandoned_ok',       'transmit_abandoned_fail',
    'create_request_sent_ok',      'create_request_sent_fail',
    'storage_object_verified_ok',  'storage_object_verified_fail',
    'wf1_triggered_ok',            'wf1_triggered_fail'
  ));

commit;

-- NOTE for 2c, not a migration step:
-- upload_events_failures_idx is a partial index WHERE event_type = 'upload_failed'. It
-- survives this migration untouched, but the new emitter never writes that value — failures
-- now arrive as {stage}_fail. The index remains valid and remains empty of new rows, so any
-- monitor built on it will read clean while failures accumulate. Query on outcome = 'fail'
-- instead, and retire or re-point the partial index when the legacy rows are no longer needed.

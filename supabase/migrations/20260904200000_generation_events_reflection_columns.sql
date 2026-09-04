-- WO-2c: the reflection loop needs somewhere to record which pass a critique came from.
-- Build spec v1.1 §4.3 control (a) requires ">= 1 critique event in the v1.4 tables WITH ITERATION
-- NUMBER". generation_events had no such column, so the acceptance criterion was unsatisfiable as
-- written. Additive and nullable: existing rows stay valid, a generate-role event has no iteration.
alter table public.generation_events add column if not exists iteration int;
alter table public.generation_events add column if not exists verdict jsonb;

-- CORRECTION, same day. The first version of this migration asserted "there is no CHECK constraint
-- on the column, so nothing rejects the new values." THAT WAS FALSE and it cost a full rehearsal
-- cycle: every critique write failed with Postgres 23514 and the HTTP node's neverError swallowed
-- it, so the loop looked healthy while persisting nothing.
--
-- The constraints existed all along, and observability v1.4 had ALREADY named this concept:
--   generation_events_call_role_check  CHECK (call_role IN ('generate','reflect','regenerate'))
--   generation_events_status_check     CHECK (status    IN ('success','api_error','invalid_output'))
--
-- So the loop uses the reserved vocabulary rather than inventing a parallel one. reflect = a
-- critique pass, regenerate = a refine pass. success = draft passed, invalid_output = draft failed
-- critique, api_error = the critique call itself failed or returned unparseable output.
comment on column public.generation_events.call_role is
  'generate | reflect | regenerate — ENFORCED by generation_events_call_role_check. reflect = a critique pass, regenerate = a refine pass (reflection loop, 2026-09-04). Consumers that group by call_role now see reflect/regenerate rows alongside generate.';
comment on column public.generation_events.status is
  'success | api_error | invalid_output — ENFORCED by generation_events_status_check. For call_role=reflect: success = draft passed, invalid_output = draft failed critique, api_error = the critique call itself failed or did not parse.';
comment on column public.generation_events.iteration is
  'Reflection pass number for call_role in (reflect, regenerate). 1-based. NULL for call_role=generate.';
comment on column public.generation_events.verdict is
  'Critique output: {passed: bool, failed_criteria: [...], notes: "..."}. NULL for call_role=generate.';

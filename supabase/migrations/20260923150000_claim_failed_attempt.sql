-- crash -> no-answer, step 1 (2026-09-23). Let the fleet error handler mark a crashed run as
-- failed so the owner is told, instead of waiting out the 10-minute no_answer deadline.
--
-- THE GAP THIS CLOSES
-- generation_attempts already carries five terminals and GenerateModal already renders a `failed`
-- state. But `failed` was only ever written by the generator reporting on itself, and a crashed
-- generator reports nothing. So a crash produced no terminal at all: pollOutcome ran to its
-- 10-minute deadline and resolved `no_answer` ("It may have arrived, or it may have failed"),
-- which is honest but makes the owner wait ten minutes to learn nothing.
--
-- WHY THIS KEYS ON n8n_execution_id AND NOT client_request_id
-- An n8n Error Trigger receives execution.id and little else; the crashed run's payload is not
-- handed to it. generation_attempts already stamps n8n_execution_id at insert (generator node
-- 'Log Attempt', depth 10 of 37), so the join key already exists with no payload archaeology.
-- Execution ids are unique per instance, so the handler can fire for all 31 workflows that point
-- at it without a workflow filter: a non-generator execution id simply matches no row.
--
-- THE `outcome is null` GUARD IS LOAD-BEARING. A crash in a node AFTER delivery must never
-- rewrite a delivered run into failed. Without it the handler would corrupt the one signal this
-- whole chain exists to carry.
--
-- Returns the id it marked, or NO ROW when there was nothing to mark: a crash BEFORE Log Attempt
-- (no row yet) and a run that already terminated are both legitimately "no row", and the caller
-- must not invent a failure for either. The crash-before-Log-Attempt case is a known residual —
-- those runs still resolve as no_answer.
create or replace function public.claim_failed_attempt(p_execution_id text, p_detail jsonb default null)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.generation_attempts
     set outcome = 'failed',
         outcome_at = now(),
         outcome_detail = coalesce(p_detail, outcome_detail)
   where n8n_execution_id = p_execution_id
     and outcome is null
  returning id;
$$;

-- REVOKE FROM PUBLIC does NOT strip Supabase's default grants to anon/authenticated: name them.
-- Verified after apply: roles_with_execute = {postgres, service_role}.
revoke all on function public.claim_failed_attempt(text, jsonb) from public;
revoke execute on function public.claim_failed_attempt(text, jsonb) from anon, authenticated;
grant execute on function public.claim_failed_attempt(text, jsonb) to service_role;

comment on function public.claim_failed_attempt(text, jsonb) is
  'Marks a crashed generation run failed, keyed on n8n_execution_id, only while outcome is null. Called by the FAR Error Handler (hELwDs82kessDugn) as service_role. No row = nothing to mark (crash before Log Attempt, or already terminated).';

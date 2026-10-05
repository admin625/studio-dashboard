-- WO-4 Phase 3 (QL rework, spec v0.7 D4): the app reads a flagged delivery from the DB.
--
-- The reworked generator delivers every post. When the post isn't clean after the single refine,
-- it writes outcome 'delivered_flagged' plus the delivery_id, and the content_deliveries row
-- carries quality_flag / flag_reason / flag_phrase (Phase M, M3). The modal learns the flag from
-- this function, not from the webhook response (HQ 2026-10-01: Respond Flagged was removed).
--
-- Two changes:
--   1. Return the delivery's three flag columns. A LEFT JOIN, so a row with no delivery (or a
--      delivery from before M3) comes back with nulls. The app reads null as "not flagged".
--   2. Critic output never leaves the database (doctrine §3: "Critic output is internal and is
--      never shown to the owner"). Until now needs_review rows returned the reviewer's notes,
--      failed_criteria and iterations to the browser, and GenerateModal rendered the notes.
--      They are stripped here, so removing them from the UI isn't the only fence.
--
-- The return type changes, so this is a drop and a create. Both are in ONE migration (one
-- transaction), so a deployed app polling the function never sees it missing. The old app reads
-- only outcome / outcome_detail / delivery_id, so the extra columns don't affect it, and the order
-- doesn't matter: this can be applied before or after the app deploy.

drop function if exists public.get_generation_outcome(uuid);

create function public.get_generation_outcome(p_client_request_id uuid)
returns table (
  outcome text,
  outcome_detail jsonb,
  delivery_id uuid,
  quality_flag boolean,
  flag_reason text,
  flag_phrase text
)
language sql
stable
security definer
set search_path = public
as $$
  select a.outcome,
         case when jsonb_typeof(a.outcome_detail) = 'object'
              then a.outcome_detail - 'notes' - 'failed_criteria' - 'iterations'
              else null end,
         a.delivery_id,
         d.quality_flag,
         d.flag_reason,
         d.flag_phrase
  from public.generation_attempts a
  left join public.content_deliveries d on d.id = a.delivery_id
  where a.client_request_id = p_client_request_id
    and a.studio_id in (select unnest(public.get_my_studio_ids()))
  limit 1
$$;

-- Supabase grants EXECUTE to anon/authenticated by default; REVOKE FROM PUBLIC alone does not
-- strip them. Only signed-in users may call it. A drop + create loses the old grants, so all
-- three are restated.
revoke all on function public.get_generation_outcome(uuid) from public;
revoke execute on function public.get_generation_outcome(uuid) from anon;
grant execute on function public.get_generation_outcome(uuid) to authenticated;

comment on function public.get_generation_outcome(uuid) is
  'Outcome of ONE generation request the caller holds the client_request_id for (GenerateModal poll), plus the delivery''s quality flag. Critic keys stripped. SECURITY DEFINER; studio membership re-checked; no listing.';

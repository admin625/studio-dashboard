-- HQ 2026-09-21 item 3: go narrower. Replaces the member SELECT policy from 150100.
--
-- That policy let any studio member (owner or active instructor) read EVERY attempt in the
-- studio, including outcome_detail.notes: the reviewer's free text on a draft, which can quote
-- the draft. So instructors could read the reviewer's notes on the owner's runs. Reviewer notes
-- on an owner's runs are the owner's.
--
-- Now a caller gets exactly one thing: the outcome of a request id they hold. The id is minted
-- in the caller's own browser (crypto.randomUUID) and never listed anywhere, so holding it is
-- the capability. Studio membership is still checked as a second fence. A row that is not found
-- and a row that is not yours look identical (no rows), so the function reveals nothing.
--
-- The drop and the create are ONE migration (one transaction): there is no window where both
-- the policy and the function exist, and no window where neither does for a deployed app. The
-- app that polls is not on main until after this.

drop policy if exists generation_attempts_member_select on public.generation_attempts;
-- generation_attempts is back to RLS-on, no policies: deny-all to anon/authenticated for direct reads.

create or replace function public.get_generation_outcome(p_client_request_id uuid)
returns table (outcome text, outcome_detail jsonb, delivery_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select a.outcome, a.outcome_detail, a.delivery_id
  from public.generation_attempts a
  where a.client_request_id = p_client_request_id
    and a.studio_id in (select unnest(public.get_my_studio_ids()))
  limit 1
$$;

-- Supabase grants EXECUTE to anon/authenticated by default; REVOKE FROM PUBLIC alone does not
-- strip them. Only signed-in users may call it.
revoke all on function public.get_generation_outcome(uuid) from public;
revoke execute on function public.get_generation_outcome(uuid) from anon;
grant execute on function public.get_generation_outcome(uuid) to authenticated;

comment on function public.get_generation_outcome(uuid) is
  'Outcome of ONE generation request the caller holds the client_request_id for (GenerateModal poll). SECURITY DEFINER; studio membership re-checked; no listing.';

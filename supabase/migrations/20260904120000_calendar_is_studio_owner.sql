-- Content Calendar WO-2a step 1 — is_studio_owner()
-- Spec: fca-content-calendar-build-spec-v1.1.md §3.11 (decision 2.17).
--
-- First owner-role predicate in the schema. get_my_studio_id() / get_my_studio_ids() scope by
-- STUDIO, not by role — the plural includes instructors — so neither can express owner-only.
-- lower() on BOTH sides: custom_access_token_hook lowercases, resolvers must not assume it.
-- No anon EXECUTE from birth; the validate_attribution_code() finding is not repeated.
-- REVOKE FROM PUBLIC does not strip Supabase's default anon/authenticated grants, so both are
-- revoked explicitly before the single intended grant.

create or replace function public.is_studio_owner(p_studio_id uuid)
returns boolean language sql security definer stable set search_path = public as $fn$
  select exists (
    select 1 from studio_accounts s
    where s.id = p_studio_id
      and lower(s.owner_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$fn$;

revoke all     on function public.is_studio_owner(uuid) from public;
revoke execute on function public.is_studio_owner(uuid) from anon, authenticated;
grant  execute on function public.is_studio_owner(uuid) to authenticated;

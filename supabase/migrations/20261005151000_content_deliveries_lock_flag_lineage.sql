-- WO-4 Phase 3 review finding (2026-10-05, CRITICAL): clients can write the flag and lineage.
--
-- authenticated holds table-level UPDATE on content_deliveries, and the UPDATE policies
-- (cd_update_owner: studio_id = get_my_studio_id(); cd_update_own: instructor_email = jwt email)
-- restrict ROWS, not columns. Phase M (M3) added quality_flag / flag_reason / flag_phrase /
-- regenerated_from under that same grant. So an owner can PATCH, straight through PostgREST:
--   - quality_flag=true on any clean delivery, which makes it regenerate-eligible;
--   - regenerated_from=null on a regenerate, which resets lineage (unlimited regenerates);
--   - regenerated_from=<any id> on any row, which forges lineage the entitlement WO will read.
-- generate-content.js gates regenerates on exactly these columns, so the gate is only as good
-- as their write path. Only the generator (service_role) may set them.
--
-- A trigger rather than a column-grant rewrite: REVOKE UPDATE (col) does nothing while a
-- table-level UPDATE grant stands, and replacing the table grant with per-column grants would
-- have to list every editable column and silently break the next column someone adds.
-- update_delivery_post_field (SECURITY INVOKER, runs as authenticated) writes only the
-- <platform>_content columns, so it is unaffected. The generator writes as service_role;
-- SECURITY DEFINER functions run as their owner. Both pass.

create or replace function public.content_deliveries_lock_flag_lineage()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.quality_flag     is distinct from old.quality_flag
    or new.flag_reason      is distinct from old.flag_reason
    or new.flag_phrase      is distinct from old.flag_phrase
    or new.regenerated_from is distinct from old.regenerated_from
  ) then
    raise exception 'quality_flag, flag_reason, flag_phrase and regenerated_from are set by the generator only'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- A trigger function is never called directly; strip the default EXECUTE grants anyway.
revoke all on function public.content_deliveries_lock_flag_lineage() from public;
revoke execute on function public.content_deliveries_lock_flag_lineage() from anon, authenticated;

drop trigger if exists content_deliveries_lock_flag_lineage on public.content_deliveries;
create trigger content_deliveries_lock_flag_lineage
  before update on public.content_deliveries
  for each row execute function public.content_deliveries_lock_flag_lineage();

-- Rehook (item 3), 2026-09-23. Render cap of 3 per reel, and reel_hook_captures becomes repo-owned.
--
-- WHY THIS FILE RECORDS A TABLE IT DOES NOT CREATE FRESH
-- reel_hook_captures was created outside this repo (SQL editor or n8n) and appears in NO migration:
-- a migration search for it returns nothing, which reads exactly like "never existed". It does exist,
-- with 27 rows since 2026-07. The CREATE below is the live DDL verbatim, guarded by IF NOT EXISTS, so
-- from here the repo owns the shape. hook_edited is a GENERATED column, never written by a caller:
-- an "edited" capture is produced by inserting the ORIGINAL proposal in proposed_text and the studio's
-- wording in final_text. Read 2026-09-23: 0 of 27 rows have hook_edited = true.
create table if not exists public.reel_hook_captures (
  capture_id    uuid primary key default gen_random_uuid(),
  reel_id       uuid not null,
  studio_id     uuid not null,
  overlay_index integer not null default 0,
  proposed_text text,
  final_text    text,
  hook_edited   boolean generated always as (final_text is distinct from proposed_text) stored,
  captured_at   timestamptz not null default now()
);
create index if not exists idx_reel_hook_captures_studio_time
  on public.reel_hook_captures using btree (studio_id, captured_at);
alter table public.reel_hook_captures enable row level security;  -- already on; no policy: service_role only

-- Referential integrity the table never had (it carried a PRIMARY KEY and nothing else).
-- NOT VALID on the reel FK, deliberately: one 2026-07-05 capture (69fe8783…, The Local Kollective)
-- points at a reel_id that no longer exists in reel_edls. Captures are the voice-fidelity signal and
-- are not pruned, so the historical row stays and every NEW row is checked.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reel_hook_captures_reel_id_fkey') then
    alter table public.reel_hook_captures
      add constraint reel_hook_captures_reel_id_fkey
      foreign key (reel_id) references public.reel_edls(reel_id) on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reel_hook_captures_studio_id_fkey') then
    alter table public.reel_hook_captures
      add constraint reel_hook_captures_studio_id_fkey
      foreign key (studio_id) references public.studio_accounts(id);
  end if;
end $$;
create index if not exists idx_reel_hook_captures_reel_time
  on public.reel_hook_captures using btree (reel_id, captured_at desc);

-- RLS denies the browser already; the grants should not outlive that. service_role is unaffected.
revoke insert, update, delete, truncate, references, trigger on public.reel_hook_captures from authenticated;
revoke all on public.reel_hook_captures from anon;

-- The render counter. Backfilled from captures: one capture row per accepted submit, so two reels
-- from 2026-07 (6 and 5 submits, both before the 2026-08-06 one-shot guard) start ALREADY over cap
-- rather than being handed three fresh renders.
alter table public.reel_edls add column if not exists render_count integer not null default 0;
update public.reel_edls e
   set render_count = c.n
  from (select reel_id, count(*)::int as n from public.reel_hook_captures group by reel_id) c
 where c.reel_id = e.reel_id and e.render_count = 0;

-- The cap itself. n8n cannot increment safely on its own (read-then-write races), so the claim is one
-- atomic statement: it returns the new count when a slot was taken, and NO ROW when the cap is reached.
-- That "no row" is what WF2 refuses on.
create or replace function public.claim_render_slot(p_reel_id uuid, p_max int)
returns int
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.reel_edls
     set render_count = render_count + 1,
         updated_at = now()
   where reel_id = p_reel_id
     and render_count < p_max
  returning render_count;
$$;

-- REVOKE FROM PUBLIC does NOT strip Supabase's default grants to anon/authenticated: both are named.
revoke all on function public.claim_render_slot(uuid, int) from public;
revoke execute on function public.claim_render_slot(uuid, int) from anon, authenticated;
grant execute on function public.claim_render_slot(uuid, int) to service_role;

comment on column public.reel_edls.render_count is
  'Renders claimed for this reel. Incremented only by claim_render_slot(); the cap (3) lives in WF2, which refuses with render_cap_reached when the claim returns no row.';

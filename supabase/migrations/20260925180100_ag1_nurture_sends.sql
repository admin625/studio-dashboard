-- AG-1 B1.2 (WO-2b, 2026-09-25): one row per nurture email actually sent. UNIQUE(studio_id, day) is the
-- duplicate-send guard (spec v0.9 AG-1.5b). Written only by the nurture workflow with the service role,
-- AFTER Resend returns success.
create table if not exists public.nurture_sends (
  id                uuid        primary key default gen_random_uuid(),
  studio_id         uuid        not null references public.studio_accounts(id) on delete cascade,
  day               int         not null,
  sent_at           timestamptz not null default now(),
  resend_message_id text,
  constraint nurture_sends_studio_day_key unique (studio_id, day)
);

-- Service-role only: RLS on with no policies denies anon/authenticated; the explicit revoke removes
-- Supabase's default table grants as well (same pattern as generation_attempts, 20260921200100).
alter table public.nurture_sends enable row level security;
revoke all on table public.nurture_sends from anon, authenticated;

comment on table public.nurture_sends is
  'AG-1.5 nurture send log. day = schedule offset (0,1,3,4,6). Service-role writes only; one row per (studio_id, day).';

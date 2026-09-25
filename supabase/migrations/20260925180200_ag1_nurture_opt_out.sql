-- AG-1 B1.4 (K5, WO-2b, 2026-09-25): nurture unsubscribe flag. Set by hand (named-target UPDATE, logged)
-- within 10 days of an "unsubscribe" reply to admin@fiorsaoirse.com. Stops days 0, 1, 3 and 6; the
-- day-4 billing notice always sends.
alter table public.studio_accounts
  add column if not exists nurture_opt_out boolean not null default false;

comment on column public.studio_accounts.nurture_opt_out is
  'AG-1.5d (K5) nurture opt-out. true = skip nurture days 0/1/3/6. Day-4 billing notice always sends.';

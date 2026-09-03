-- 20260903140000_ambassador_attribution.sql
-- WO-3a step 4. FAR spec v1.3 (ratified 2026-09-03), HQ build authorization.
--
-- ⚠ VIEW DEFINITIONS ARE CONSTRUCTED, NOT TRANSCRIBED. v1.3 does not exist on disk (WO-3a
-- step 1 confirmed: Decisions/ambassador/ holds only v1.1). The three views below are built
-- from the work order's one-line descriptions — "studio_ambassador Branch B with Katie wall",
-- "ambassador_commissions with 24-month count cap", "ambassador_payout_due". "Branch B" in
-- particular has no definition available to HAL; v1.1 contains the string zero times. These
-- are a faithful reading of the descriptions, NOT a transcription of §4.5, and they need
-- checking against v1.3 before any payout is computed from them.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- ambassadors
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ambassadors (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^amb_[a-z0-9_]{3,60}$'),
  display_name  text not null,
  email         text,
  studio_id     uuid references studio_accounts(id),
  rate          numeric(4,3) not null default 0.300 check (rate between 0 and 1),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Partial unique index, not a column constraint: an ambassador may have no email (Jamie),
-- and several NULLs must not collide.
create unique index if not exists ambassadors_email_lower_uq
  on ambassadors (lower(email)) where email is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- studio_accounts — attribution + the frozen price basis
-- ─────────────────────────────────────────────────────────────────────────────
-- signup_price is added here because WO-1 confirmed it does not exist, and the whole
-- commission model freezes against it. Until a writer populates it, every commission is
-- NULL rather than wrong, which is the correct failure direction.
alter table studio_accounts
  add column if not exists referral_ambassador_id       uuid references ambassadors(id),
  add column if not exists referral_source              text check (referral_source in ('checkout_client_reference_id','hq_manual')),
  add column if not exists referral_checkout_session_id text unique,
  add column if not exists referral_attributed_at       timestamptz,
  add column if not exists signup_price                 numeric(10,2),
  add column if not exists signup_currency              text check (signup_currency ~ '^[a-z]{3}$');

-- ─────────────────────────────────────────────────────────────────────────────
-- checkout_attributions — the raw landing zone for checkout.session.completed
-- ─────────────────────────────────────────────────────────────────────────────
-- PK on the Stripe session id makes redelivery idempotent by construction. WO-1 established
-- that q7 already subscribes to this event and a second endpoint is being added, so both
-- workflows will see every session; the PK is what stops the second one double-writing.
create table if not exists checkout_attributions (
  checkout_session_id    text primary key,
  stripe_customer_id     text not null,
  client_reference_id    text,
  ambassador_code        text,
  amount_total           bigint not null,
  currency               text not null,
  payment_link_id        text,
  received_at            timestamptz not null default now(),
  applied_at             timestamptz,
  studio_id              uuid references studio_accounts(id),
  apply_error            text,
  manual_ambassador_code text,
  manual_reason          text,
  manual_attributed_at   timestamptz,
  constraint checkout_attributions_manual_all_or_none check (
    (manual_ambassador_code is null and manual_reason is null and manual_attributed_at is null) or
    (manual_ambassador_code is not null and manual_reason is not null and manual_attributed_at is not null))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ambassador_reconciliation_months — column set per the work order's inline spec
-- ─────────────────────────────────────────────────────────────────────────────
-- Insert-only except paid_out_at. Not enforced by trigger in this migration: the work order
-- specifies the property but not the mechanism, and an unrequested trigger on a money table
-- is the kind of structure that should be decided, not assumed. Flagged in the report.
create table if not exists ambassador_reconciliation_months (
  studio_id         uuid not null references studio_accounts(id),
  period_month      date not null,
  stripe_invoice_id text,
  net_paid          numeric(10,2) not null default 0,
  counted           boolean not null default false,
  paid_out_at       timestamptz,
  created_at        timestamptz not null default now(),
  primary key (studio_id, period_month)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- plan_type domain lock
-- ─────────────────────────────────────────────────────────────────────────────
-- Accepts the three values live today (WO-1: enterprise 6 / studio 3 / studio_basic 1, no
-- NULLs, no whitespace or case variants). Rejects 'owner'. NOTE: plan_type is nullable, so a
-- NULL still passes this CHECK by SQL semantics — the constraint locks the domain, it does
-- not make the column required.
alter table studio_accounts
  drop constraint if exists studio_accounts_plan_type_chk;
alter table studio_accounts
  add constraint studio_accounts_plan_type_chk
  check (plan_type in ('enterprise','studio','studio_basic'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Views. service_role only, matching reel_upload_chain.
-- ─────────────────────────────────────────────────────────────────────────────
-- The Katie wall: 948e26f4-… is excluded structurally, in the view, not by a runtime filter
-- a caller has to remember. She is permanent-free owner-tier and a business partner; any
-- arrangement with her is separate terms, so she must never appear in a commission surface.
create or replace view studio_ambassador as
select s.id                            as studio_id,
       s.studio_name,
       s.owner_name,
       s.plan_type,
       s.subscription_status,
       s.signup_price,
       s.signup_currency,
       s.referral_source,
       s.referral_checkout_session_id,
       s.referral_attributed_at,
       a.id                            as ambassador_id,
       a.code                          as ambassador_code,
       a.display_name                  as ambassador_name,
       a.rate                          as ambassador_rate,
       a.active                        as ambassador_active
from studio_accounts s
join ambassadors a on a.id = s.referral_ambassador_id
where s.id <> '948e26f4-5996-4e11-9b86-c89664b0e600'::uuid;

-- Commission is FROZEN against signup_price, never against current price. Months are counted
-- only where counted = true, and capped at 24 per studio — the cap is applied with a window
-- rank so a 25th counted month is excluded rather than silently inflating the total.
create or replace view ambassador_commissions as
with capped as (
  select m.studio_id,
         m.period_month,
         m.net_paid,
         m.paid_out_at,
         row_number() over (partition by m.studio_id order by m.period_month) as counted_month_no
  from ambassador_reconciliation_months m
  where m.counted
)
select sa.ambassador_id,
       sa.ambassador_code,
       sa.ambassador_name,
       sa.studio_id,
       sa.studio_name,
       sa.signup_price,
       sa.signup_currency,
       sa.ambassador_rate,
       round(sa.signup_price * sa.ambassador_rate, 2) as commission_per_month,
       c.period_month,
       c.counted_month_no,
       c.net_paid,
       c.paid_out_at
from studio_ambassador sa
join capped c on c.studio_id = sa.studio_id
where c.counted_month_no <= 24;

create or replace view ambassador_payout_due as
select ambassador_id,
       ambassador_code,
       ambassador_name,
       signup_currency,
       count(*)                              as months_due,
       min(period_month)                     as earliest_month,
       max(period_month)                     as latest_month,
       sum(commission_per_month)             as amount_due
from ambassador_commissions
where paid_out_at is null
  and commission_per_month is not null
group by ambassador_id, ambassador_code, ambassador_name, signup_currency;

-- Supabase grants SELECT on new public objects to anon/authenticated by default, and
-- REVOKE FROM PUBLIC does not strip that. The named roles must be revoked explicitly.
revoke all on studio_ambassador, ambassador_commissions, ambassador_payout_due from public;
revoke all on studio_ambassador, ambassador_commissions, ambassador_payout_due from anon, authenticated;
grant select on studio_ambassador, ambassador_commissions, ambassador_payout_due to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 6 — RLS. Enabled with ZERO policies: service_role bypasses, everyone else is denied.
-- ─────────────────────────────────────────────────────────────────────────────
alter table ambassadors                      enable row level security;
alter table checkout_attributions            enable row level security;
alter table ambassador_reconciliation_months enable row level security;

revoke all on ambassadors, checkout_attributions, ambassador_reconciliation_months from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 5 — seed. Two rows. studio_id resolved by name, not hardcoded.
-- ─────────────────────────────────────────────────────────────────────────────
insert into ambassadors (code, display_name, email, studio_id)
select 'amb_jamie_trout', 'Jamie Trout', null,
       (select id from studio_accounts where studio_name = 'International Pilates Center')
where not exists (select 1 from ambassadors where code = 'amb_jamie_trout');

insert into ambassadors (code, display_name, email, studio_id)
select 'amb_beth_domino', 'Beth Domino', 'internationalpilatesnz@gmail.com',
       (select id from studio_accounts where studio_name = 'International Pilates NZ')
where not exists (select 1 from ambassadors where code = 'amb_beth_domino');

commit;

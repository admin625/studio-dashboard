-- 20260903171500_ambassador_align_to_v13.sql
-- WO-3a addendum. Aligns the WO-3a build to ratified spec v1.3 §4.4 / §4.5, now committed at
-- fiorsaoirse-brain, Decisions / ambassador / ambassador-attribution v1.3 (62f1b20).
--
-- WO-3a built the views and the ledger from one-line descriptions because v1.3 was not on
-- disk. §4.4/§4.5 turn out to specify exact DDL. Every divergence below is unambiguous, so
-- every one is corrected here. `ambassador_reconciliation_months` is empty (0 rows), so the
-- column changes carry no data risk.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4.4 — ambassador_reconciliation_months. Four divergences.
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ ORDER MATTERS: the views are dropped FIRST. Postgres refuses `alter column ... type` on a
-- column a view depends on ("cannot alter type of a column used by a view or rule") — the first
-- apply attempt failed exactly there, on ambassador_commissions depending on net_paid.
drop view if exists ambassador_payout_due;
drop view if exists ambassador_commissions;
drop view if exists studio_ambassador;

-- 1. stripe_invoice_id: built nullable, spec says NOT NULL. A ledger month with no invoice
--    is not a reconciled month, so the constraint is the point.
alter table ambassador_reconciliation_months
  alter column stripe_invoice_id set not null;

-- 2. net_paid: built numeric(10,2), spec says BIGINT. Not cosmetic — bigint is Stripe's
--    minor-unit convention, matching checkout_attributions.amount_total. Storing dollars in
--    one table and cents in the other is how a 100x error reaches a payout.
alter table ambassador_reconciliation_months
  alter column net_paid drop default,
  alter column net_paid type bigint using round(net_paid)::bigint;

-- 3. counted: built with `default false`, spec has NOT NULL and no default. A default makes
--    "nobody decided" indistinguishable from "decided: not counted" on a money ledger.
alter table ambassador_reconciliation_months
  alter column counted drop default;

-- 4. created_at -> reconciled_at. Spec names the moment reconciliation ran, not row birth.
alter table ambassador_reconciliation_months
  rename column created_at to reconciled_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4.5 — views. Rebuilt verbatim from the spec.
-- ─────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE cannot change a view's column set or names, so these are dropped (above,
-- before the column alters) and recreated here, in dependency order.
--
-- The built versions carried extra columns and DIFFERENT NAMES (ambassador_code/ambassador_rate
-- vs the spec's code/rate). That was not merely wider: §4.5's ambassador_commissions selects
-- `sa.code` and `sa.rate`, which the built studio_ambassador does not expose. The spec's own
-- view body would not have compiled against the built one.

create view studio_ambassador as
select s.id as studio_id, a.id as ambassador_id, a.code, a.rate, s.referral_attributed_at as attributed_at
from studio_accounts s
join ambassadors a on a.id = s.referral_ambassador_id
where s.id <> '948e26f4-5996-4e11-9b86-c89664b0e600';           -- Katie wall

-- 24-month cap, spec form: count of PRIOR counted months < 24.
-- The built form used row_number() <= 24. Those are equivalent here — the Nth counted month
-- has N-1 priors, so N-1 < 24 iff N <= 24, and the PK (studio_id, period_month) rules out
-- ties that could separate them. Replaced with the spec's form anyway: equivalence today is
-- not equivalence after someone edits the PK, and the spec is the artifact people will read.
create view ambassador_commissions as
select m.studio_id, sa.code as ambassador_code, m.period_month, m.stripe_invoice_id, m.net_paid,
       round(s.signup_price * sa.rate, 2) as commission_due, s.signup_currency, m.paid_out_at
from ambassador_reconciliation_months m
join studio_accounts s    on s.id = m.studio_id
join studio_ambassador sa on sa.studio_id = m.studio_id
where m.counted
  and (select count(*) from ambassador_reconciliation_months x
       where x.studio_id = m.studio_id and x.counted and x.period_month < m.period_month) < 24;

-- Built version carried an extra `and commission_per_month is not null` filter. Removed: the
-- spec does not have it, and it would hide a studio with a NULL signup_price from the payout
-- surface instead of showing it as a NULL amount. A missing price should be visible.
create view ambassador_payout_due as
select ambassador_code, signup_currency, count(*) as months, sum(commission_due) as due
from ambassador_commissions where paid_out_at is null group by 1, 2;

-- referral_divergence — §4.5, NOT BUILT IN WO-3a AT ALL. The work order named three views;
-- the spec defines four. This is the §5.4 divergence check: provisioning's referral_code
-- versus our attribution, alerting when they disagree in either direction.
create view referral_divergence as
select s.id as studio_id, s.referral_code, s.referral_ambassador_id, a.id as code_resolves_to
from studio_accounts s
left join ambassadors a on a.code = lower(trim(s.referral_code))
where s.id <> '948e26f4-5996-4e11-9b86-c89664b0e600'
  and (a.id is distinct from s.referral_ambassador_id)
  and (a.id is not null or s.referral_ambassador_id is not null);

-- Supabase grants SELECT on new public objects to anon/authenticated by default and REVOKE
-- FROM PUBLIC does not strip that. Re-asserted after the drop/create cycle.
revoke all on studio_ambassador, ambassador_commissions, ambassador_payout_due, referral_divergence from public;
revoke all on studio_ambassador, ambassador_commissions, ambassador_payout_due, referral_divergence from anon, authenticated;
grant select on studio_ambassador, ambassador_commissions, ambassador_payout_due, referral_divergence to service_role;

commit;

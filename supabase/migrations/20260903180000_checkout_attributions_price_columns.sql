-- 20260903180000_checkout_attributions_price_columns.sql
-- WO-3b step 1, per spec v1.3.1 §4.3.
--
-- WHY THESE TWO COLUMNS EXIST. v1.3 §5.3 derived signup_price from the session's
-- amount_total. The founding payment link carries trial_period_days: 5, so every session
-- through it returns amount_total: 0 — verified live on all three completed sessions. That
-- would have written signup_price = 0.00 to every attributed studio and made every
-- commission 30% of nothing, while the step 11 control passed.
--
-- v1.3.1 reads the price from the expanded line item instead. These columns land the basis
-- alongside the session so a commission can be audited against what Stripe actually charged,
-- rather than recomputed later from an object that may have been edited or archived.
--
-- amount_total is still landed, unchanged. It is not the price, but it is what the event
-- carried, and a landing table that quietly drops a field it received is not an audit trail.

alter table checkout_attributions
  add column if not exists stripe_price_id   text,
  add column if not exists price_unit_amount bigint;

-- The sweep's hot query is "rows never applied". Partial index so it stays proportional to
-- the backlog rather than to total checkout history.
create index if not exists checkout_attributions_unapplied_idx
  on checkout_attributions (applied_at) where applied_at is null;

-- q7 remediation, Phase A1 — one spelling for cancellation, and it is Stripe's.
--
-- WHY. `studio_accounts.subscription_status` has been written from two vocabularies:
-- q7's `Cancel Studio` node hardcodes 'cancelled' (British) while `Update Studio Status`
-- writes Stripe's `subscription.status` verbatim, which is 'canceled' (American, one L).
-- Every predicate in this schema matched only the British spelling, so a cancellation that
-- arrived on the `customer.subscription.updated` path fired NOTHING: no `cancelled_at`
-- retention anchor, and a founding member's slot stayed claimed forever. Measured
-- 2026-09-09 by evaluating both predicates against both spellings — 'canceled' fires
-- neither. It has never happened in production only because every cancellation so far
-- arrived on the `subscription.deleted` path, which takes the hardcoded branch.
--
-- 🚨 ORDER IS LOAD-BEARING: DATA FIRST, THEN FUNCTIONS. Reversed, `stamp_cancelled_at`
-- would already match 'canceled' when the UPDATE runs, read OLD='cancelled' →
-- NEW='canceled' as a *fresh* cancellation, and re-stamp `cancelled_at = now()` on all
-- seven rows — destroying the real timestamps including the two backfilled from Stripe on
-- 2026-09-09. As written, the UPDATE below runs while the predicates still say 'cancelled',
-- so neither trigger branch matches and every `cancelled_at` is preserved untouched.

-- ---------------------------------------------------------------------------------------
-- 1. DATA. Asserted against a pre-count so a partial or silent no-op cannot pass.
do $normalise$
declare
  before_cancelled integer;
  before_canceled  integer;
  moved            integer;
  after_cancelled  integer;
begin
  select count(*) into before_cancelled from public.studio_accounts where subscription_status = 'cancelled';
  select count(*) into before_canceled  from public.studio_accounts where subscription_status = 'canceled';

  if before_canceled <> 0 then
    raise exception 'expected 0 rows already spelled canceled, found % — investigate before normalising', before_canceled;
  end if;

  update public.studio_accounts
     set subscription_status = 'canceled'
   where subscription_status = 'cancelled';
  get diagnostics moved = row_count;

  if moved <> before_cancelled then
    raise exception 'normalise moved % rows but % were counted beforehand', moved, before_cancelled;
  end if;

  select count(*) into after_cancelled from public.studio_accounts where subscription_status = 'cancelled';
  if after_cancelled <> 0 then
    raise exception 'after normalising, % rows still spelled cancelled', after_cancelled;
  end if;

  raise notice 'normalised % rows from cancelled to canceled', moved;
end
$normalise$;

-- ---------------------------------------------------------------------------------------
-- 2. FUNCTIONS. Only now, once no row carries the old spelling.
--
-- 'canceled' AND ONLY 'canceled'. Deliberately not `in ('canceled','cancelled')`: accepting
-- both would leave the ambiguity in place and let a future writer reintroduce the British
-- spelling without anything complaining. One spelling, enforced by the predicate.
create or replace function public.stamp_cancelled_at()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Stamp the retention anchor on transition INTO canceled. Spelling is Stripe's: this is
  -- the value `Update Studio Status` writes verbatim from subscription.status, and as of
  -- the q7 remediation it is what `Cancel Studio` writes too.
  if new.subscription_status = 'canceled'
     and old.subscription_status is distinct from 'canceled' then
    new.cancelled_at := now();
  -- Auto-clear on reactivation OUT of canceled (protects the 30-day window)
  elsif new.subscription_status in ('active', 'trialing')
        and old.subscription_status = 'canceled' then
    new.cancelled_at := null;
  end if;
  return new;
end;
$function$;

-- The founder-slot predicate lives in the TRIGGER's WHEN clause, not in the function body,
-- so the trigger itself has to be recreated. The function's comment is corrected in the
-- same breath because it named the old spelling and would otherwise contradict the code.
create or replace function public.release_founder_slot_on_cancel()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Release the founder slot when a founder studio transitions to canceled.
  -- release_founder_slot is idempotent (no-op if no slot held) and only clears founder
  -- flags (not subscription_status), so its own UPDATE cannot re-trip this trigger
  -- (OLD.subscription_status would already be 'canceled').
  perform public.release_founder_slot(new.id);
  return new;
end;
$function$;

drop trigger if exists trg_release_founder_slot_on_cancel on public.studio_accounts;
create trigger trg_release_founder_slot_on_cancel
  after update of subscription_status on public.studio_accounts
  for each row
  when (new.subscription_status = 'canceled'
        and old.subscription_status is distinct from 'canceled'
        and old.founding_member = true)
  execute function public.release_founder_slot_on_cancel();

-- ---------------------------------------------------------------------------------------
-- 3. ⚠ BEYOND THE LETTER OF A1, AND DELIBERATE — far_zero_delivery_scan().
--
-- It filters `sa.subscription_status NOT IN ('cancelled','inactive')` to find studios that
-- signed up and never received a delivery. Normalising the data without touching it would
-- make every cancelled studio pass that filter and start alerting as a stranded signup.
-- This is not hypothetical: measured immediately before this migration, **2 studios** match
-- its full predicate today (non-beta, cancelled, zero deliveries, created between 30 minutes
-- and 48 hours ago). Shipping A1 alone would have put two false "zero delivery after signup"
-- alerts into the next daily run. Same defect class, same migration, one word.
create or replace function public.far_zero_delivery_scan()
returns table(studio_id uuid, studio_name text, owner_email text, signup_at timestamp without time zone, hours_since_signup numeric)
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  UPDATE public.far_alerts SET resolved_at = now(), resolved_by = 'auto_delivery_detected'
   WHERE alert_type = 'zero_delivery_after_signup' AND resolved_at IS NULL
     AND studio_id IN (SELECT DISTINCT cd.studio_id FROM public.content_deliveries cd WHERE cd.studio_id IS NOT NULL);
  SELECT sa.id, sa.studio_name, sa.owner_email, sa.created_at,
         ROUND(EXTRACT(EPOCH FROM (now() - sa.created_at))/3600.0, 1)::numeric
    FROM public.studio_accounts sa
    LEFT JOIN ( SELECT cd2.studio_id AS sid, COUNT(*) AS cnt
                  FROM public.content_deliveries cd2 GROUP BY cd2.studio_id ) cd ON cd.sid = sa.id
    LEFT JOIN public.far_alerts fa ON fa.studio_id = sa.id AND fa.alert_type = 'zero_delivery_after_signup'
   WHERE sa.is_beta = false
     AND sa.subscription_status NOT IN ('canceled', 'inactive')
     AND sa.created_at < (now() - INTERVAL '30 minutes')
     AND sa.created_at > (now() - INTERVAL '48 hours')
     AND COALESCE(cd.cnt, 0) = 0
     AND ( fa.studio_id IS NULL OR fa.last_alerted_at < (now() - INTERVAL '12 hours') OR fa.resolved_at IS NOT NULL )
   ORDER BY sa.created_at ASC;
$function$;

comment on column public.studio_accounts.subscription_status is
  'Stripe''s vocabulary, one spelling: canceled (American, one L) — never cancelled. '
  'Written by q7 (q7IuW7Q85mpgOYub): Activate Studio → active, Cancel Studio → canceled, '
  'Mark Studio Past Due → past_due, and Update Studio Status → subscription.status verbatim, '
  'which is an OPEN set (active, past_due, unpaid, canceled, incomplete, incomplete_expired, '
  'trialing, paused). ''beta'' is also live on 6 rows and is written by neither q7 path. '
  'Generation is gated on an explicit ALLOWLIST (trialing|active|past_due|beta) in pTTps '
  'Check Trial Limits — never a denylist, because this column has held two spellings of no.';

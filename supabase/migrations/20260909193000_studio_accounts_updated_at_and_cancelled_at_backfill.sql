-- Entitlement repoint work order, step 5a/5b. Follows far/work-orders/subscription-status-gate-read.md
-- (FAR 7bf327b), which measured two facts this migration acts on.
--
-- FACT 1 -- studio_accounts.updated_at has never moved. The column is `DEFAULT now()` and NOTHING
-- advances it: pg_trigger carries no BEFORE UPDATE trigger of any kind on this table, no n8n node in
-- any of the 111 workflows in the 2026-09-08 snapshot writes it, and it appears nowhere in
-- studio-dashboard src/ or netlify/functions/. Measured witness: studio cf34f89e went
-- active -> cancelled on 2026-09-08 and its created_at and updated_at are still byte-identical
-- (2026-09-08 19:56:09.779 both). Anything that read updated_at as a change signal was reading a
-- creation timestamp. This migration makes the column mean what its name says.
--
-- FACT 2 -- three cancelled studios carry cancelled_at IS NULL, because they were cancelled before
-- trg_stamp_cancelled_at existed and restrictions added after the fact never backfill. Two of the
-- three are recoverable from Stripe; the third is not. See the backfill block below.
--
-- NOT IN THIS MIGRATION, deliberately: the 'cancelled' -> 'canceled' spelling normalisation. It was
-- amendment C of the work order and was withdrawn before build. Rationale recorded in the report:
-- the repointed gate uses an explicit ALLOWLIST (trialing|active|past_due|beta), which denies both
-- spellings identically, so normalisation buys consistency, not gate safety -- while its blast
-- radius is four database objects that key on the literal 'cancelled' PLUS two md5 baselines pinned
-- inside the live FCA Health Monitor (SiuP0ltf2Cs1YpZ5). It moves to the q7 remediation session,
-- bundled with the monitor rebaseline, rather than putting three active workflows in one stream.

-- ---------------------------------------------------------------------------------------------
-- 5b. Backfill cancelled_at. RUNS FIRST, BEFORE the trigger below exists.
--
-- Ordering is deliberate. If the updated_at trigger were created first, this bookkeeping backfill
-- would stamp updated_at on rows whose business state did not change today, which is exactly the
-- confusion the trigger is being added to remove. Note this UPDATE cannot fire trg_stamp_cancelled_at:
-- that trigger is BEFORE UPDATE **OF subscription_status**, and this statement touches only
-- cancelled_at.
--
-- Values are Stripe's own subscription.canceled_at, read live from acct_1SegRe98SvO3uGBL on
-- 2026-09-09 and converted from epoch. They are NOT inferred from local data.
--   17cb138d  sub_1ThB...  canceled_at 1781195424 -> 2026-06-11T16:30:24Z
--   6a4f062b  sub_1TYY...  canceled_at 1779139549 -> 2026-05-18T21:25:49Z
-- Each backfill ASSERTS it hit exactly one row. An id-scoped UPDATE that matches nothing is a
-- silent no-op: it reports success and changes nothing, and the migration would read as applied.
-- Fail loud instead. (Written this way after a wrong id in a draft of this file did exactly that.)
do $backfill$
declare n integer;
begin
  update public.studio_accounts
     set cancelled_at = timestamptz '2026-06-11T16:30:24Z'
   where id = '17cb138d-1ced-4acb-a102-cbdd5d0cb1e8'::uuid
     and cancelled_at is null;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'backfill 17cb138d expected 1 row, updated %', n;
  end if;

  update public.studio_accounts
     set cancelled_at = timestamptz '2026-05-18T21:25:49Z'
   where id = '6a4f062b-b75e-4d2c-a1ce-3778e8ea7bc7'::uuid
     and cancelled_at is null;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'backfill 6a4f062b expected 1 row, updated %', n;
  end if;
end
$backfill$;

-- The third row (1dbd8287, "Smoke Test Studio 6") is deliberately LEFT NULL. Its Stripe objects do
-- not exist in the live account: the subscription read returns "No such subscription", and the
-- customer read is explicit -- "a similar object exists in test mode, but a live mode key was used".
-- There is no live source for its timestamp, and a plausible-looking invented date is worse than a
-- NULL, because NULL is visibly missing and a wrong retention anchor is not.
comment on column public.studio_accounts.cancelled_at is
  'Retention anchor: when the subscription was cancelled. Stamped by trg_stamp_cancelled_at on the '
  'transition INTO subscription_status = ''cancelled'', and cleared on reactivation to active/trialing. '
  'NULL does NOT mean "not cancelled": rows cancelled before that trigger existed were never '
  'backfilled by it. Two such rows were backfilled from Stripe subscription.canceled_at on 2026-09-09. '
  'One row (studio 1dbd8287, "Smoke Test Studio 6") remains NULL on purpose -- its stripe_customer_id '
  'and stripe_subscription_id are TEST-MODE objects sitting in the production table, so no live-mode '
  'source for the timestamp exists. That studio is a deletion candidate, not a customer. '
  'Caveat on the backfilled values: they are the SUBSCRIPTION cancel time, which for studio 17cb138d '
  'is 2026-06-11 even though the studio stopped producing deliveries on 2026-01-30 -- its Stripe '
  'subscription was attached about five months after the studio row was created.';

-- ---------------------------------------------------------------------------------------------
-- 5a. updated_at maintenance trigger.
--
-- Plain plpgsql rather than the moddatetime extension: moddatetime is available on this project but
-- NOT installed (present in pg_available_extensions, absent from pg_extension), so a migration
-- assuming it would fail. This costs one small function and adds no extension dependency.
--
-- timezone('utc', now()) rather than bare now(): the column is `timestamp WITHOUT time zone`, so a
-- bare now() records whatever the *session* TimeZone happens to be. The project default is UTC
-- today, but that is a session setting a client can change, and a timestamp column whose meaning
-- depends on who wrote it is the defect class this table already has enough of.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Only advance on a real change. A no-op UPDATE (writing a row's existing values back) should not
  -- register as a modification, or updated_at becomes a "last touched by any job" column rather than
  -- a "last changed" one.
  if new is distinct from old then
    new.updated_at := timezone('utc', now());
  end if;
  return new;
end;
$function$;

-- Name sorts before trg_stamp_cancelled_at, so for a subscription_status UPDATE this fires first.
-- The two do not interact: this one writes updated_at, that one writes cancelled_at.
drop trigger if exists trg_set_updated_at on public.studio_accounts;
create trigger trg_set_updated_at
  before update on public.studio_accounts
  for each row
  execute function public.set_updated_at();

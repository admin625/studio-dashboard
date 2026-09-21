-- Item 7, HQ 2026-09-21: the app learns the final outcome of a generation.
--
-- generate-content.js answers 202 at 25s; slot runs take 48-83s (execs 71021/71022/71024), so the
-- generator's own terminal - including "needs review, nothing delivered" - never reached the
-- caller. Two of Katie's three taps on 2026-09-20 delivered nothing and the modal said success.
--
-- The generator now writes its terminal onto the attempt row it already creates (Log Attempt),
-- keyed by a client-generated id the app sends with the request and polls on.
--   outcome NULL  = still generating, or the run died before any terminal (the app times out
--                   honestly; it never reads NULL as success)
-- Additive and nullable: existing writers (Log Attempt) and readers are unaffected.

alter table public.generation_attempts
  add column if not exists client_request_id uuid,
  add column if not exists outcome text
    check (outcome in ('delivered', 'needs_review', 'refused', 'failed')),
  add column if not exists outcome_at timestamptz,
  add column if not exists outcome_detail jsonb,
  add column if not exists delivery_id uuid references public.content_deliveries(id) on delete set null;

-- One attempt per request id. A duplicate fails Log Attempt's insert (its error branch alerts)
-- rather than letting two runs answer one poll.
create unique index if not exists generation_attempts_client_request_id_key
  on public.generation_attempts (client_request_id)
  where client_request_id is not null;

-- 2026-09-21 review follow-up to 150000.
--
-- delivery_id references content_deliveries(id) ON DELETE SET NULL, so every delete from
-- content_deliveries scans generation_attempts for referencing rows. This table is append-only
-- and grows with every generation. Partial: most rows never get a delivery.
create index if not exists generation_attempts_delivery_id_idx
  on public.generation_attempts (delivery_id)
  where delivery_id is not null;

-- The outcome CHECK added by 150000 is inline, so Postgres named it
-- `generation_attempts_outcome_check` (verified in pg_constraint 2026-09-21). Its allowed values
-- ('delivered','needs_review','refused','failed') must change together with the generator's
-- markOutcome callers (Flag Not Ship, Refuse Held Slot, Respond Prompt Field Missing, Mark
-- Delivered) and classifyAttempt in src/lib/generationOutcome.js. A value outside the set makes
-- the generator's PATCH fail, and the app then reports "no answer".
comment on constraint generation_attempts_outcome_check on public.generation_attempts is
  'Allowed values change together with n8n markOutcome callers (pTTpsIlhtOYHqvXd) and classifyAttempt in studio-dashboard src/lib/generationOutcome.js.';

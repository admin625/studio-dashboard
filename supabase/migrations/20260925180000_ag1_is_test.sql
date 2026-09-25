-- AG-1 B1.1 [C5] (WO-2b, 2026-09-25): formal test-studio marker.
-- No marker existed; is_beta means beta, not test. Set only by HAL on a named test row, after G4 (spec v0.9 §1.4).
-- Additive; NOT NULL DEFAULT false is metadata-only on PG11+, so existing rows read false without a rewrite.
alter table public.studio_accounts
  add column if not exists is_test boolean not null default false;

comment on column public.studio_accounts.is_test is
  'AG-1 C5 test marker. true = deliberate internal test studio (not a customer). Excluded by the Stranded Alert (AG-1.6). NOT excluded by nurture, by design (spec v0.9 §1.4).';

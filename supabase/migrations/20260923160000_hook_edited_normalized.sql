-- hook_edited normalization, 2026-09-23.
--
-- WHY. hook_edited is the voice-fidelity signal: did the studio change OUR words? On 2026-09-23 the
-- first true row in the table's history (cbebaddc) was produced by autocorrect swapping a hyphen for
-- an EN DASH. Both strings are 45 characters and read identically on screen; only a hex compare found
-- it. A dash substitution is not a voice edit, and every count built on this column would have carried
-- it as one. Same class as the Supabase invisible-whitespace trap: equal length, identical on screen,
-- different bytes.
--
-- Folds: unicode dashes -> '-', curly quotes -> straight, NBSP/thin space -> space, collapse runs of
-- whitespace, trim, lowercase. Both sides of translate() are written as U&'...' codepoint escapes so
-- there is not a single literal quote character to be mangled by a quoting layer.
create or replace function public.hook_norm(t text)
returns text
language sql
immutable
parallel safe
as $$
  select lower(btrim(regexp_replace(
    translate(
      t,
      -- 2010 2011 2012 2013 2014 2015 2212 | 2018 2019 201A 201B | 201C 201D 201E 201F | 00A0 202F 2009
      U&'\2010\2011\2012\2013\2014\2015\2212\2018\2019\201A\201B\201C\201D\201E\201F\00A0\202F\2009',
      -- 7x hyphen-minus        | 4x apostrophe        | 4x quotation mark    | 3x space
      U&'\002D\002D\002D\002D\002D\002D\002D\0027\0027\0027\0027\0022\0022\0022\0022\0020\0020\0020'
    ),
    '\s+', ' ', 'g')))
$$;

comment on function public.hook_norm(text) is
  'Normalises a hook for comparison: unicode dashes and curly quotes folded, whitespace collapsed, trimmed, lowercased. IMMUTABLE so it can back a generated column. NOTE: reel_hook_captures.hook_edited is STORED, computed at write time - changing this function does NOT recompute existing rows; that needs another drop/re-add of the column.';

-- A generated column's expression cannot be altered in place, so the column is dropped and re-added.
-- Re-adding recomputes every existing row, which IS the backfill. Nothing depends on the column
-- (verified before applying: no views, indexes, constraints or policies reference it), so the drop is
-- safe. The column moves to the end of the table; every writer names its fields, so ordinal position
-- is unused.
alter table public.reel_hook_captures drop column if exists hook_edited;

alter table public.reel_hook_captures
  add column hook_edited boolean
  generated always as (public.hook_norm(final_text) is distinct from public.hook_norm(proposed_text)) stored;

comment on column public.reel_hook_captures.hook_edited is
  'True when the studio changed our words in a way that survives normalisation. A dash or quote substitution, a case change, or whitespace alone does NOT count - see hook_norm(). Computed at write time.';

-- Verified after apply, 31 captures:
--   cbebaddc (hyphen vs en dash)                 true -> FALSE   raw_equal false, norm_equal true
--   6fd25e0b (real word change, Reel A)          stays TRUE      raw_equal false, norm_equal false
--   12-case fold matrix: 8 folds read false, 4 real changes read true, 12/12 pass
--   table-wide: 1 true (was 2), 30 false, 0 null

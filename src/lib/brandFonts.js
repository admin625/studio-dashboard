/**
 * brandFonts.js — the font picker's option list.
 *
 * Extracted from BrandSettings.jsx so it can be asserted against in tests
 * without loading the page (which pulls in supabase.js at module scope).
 * This is the ONLY definition. BrandSettings imports it.
 *
 * Invariant: every value ever written to studio_accounts.brand_font must
 * appear here. The column has no CHECK constraint, so a value that drifts
 * out of this list renders as an empty <select> and the next save writes
 * the empty string back over it. That is silent data loss, not a UI bug.
 */
export const FONTS = [
  { value: '', label: 'Default (System)' },
  { value: 'Inter', label: 'Inter' },
  { value: 'Montserrat', label: 'Montserrat' },
  { value: 'Poppins', label: 'Poppins' },
  { value: 'Playfair Display', label: 'Playfair Display' },
  { value: 'Raleway', label: 'Raleway' },
  { value: 'Oswald', label: 'Oswald' },
  { value: 'Lato', label: 'Lato' },
  { value: 'Roboto', label: 'Roboto' },
  { value: 'Open Sans', label: 'Open Sans' },
  { value: 'Bebas Neue', label: 'Bebas Neue' },
]

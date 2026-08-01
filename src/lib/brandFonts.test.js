import { describe, it, expect } from 'vitest'
import { FONTS } from './brandFonts'

// Values observed in studio_accounts.brand_font on fca-studio, 2026-08-01.
// Add to this list when a studio adopts a new font; never remove one that
// is still stored. brand_font has no CHECK constraint, so this test is the
// only thing standing between a dropped option and silent data loss.
const STORED_IN_PRODUCTION = ['Inter', 'Montserrat']

describe('brand_font options', () => {
  const values = FONTS.map(f => f.value)

  it('can represent every brand_font value stored in production', () => {
    for (const font of STORED_IN_PRODUCTION) expect(values).toContain(font)
  })

  it('offers an empty default so "unset" is selectable', () => {
    expect(values).toContain('')
  })

  it('has no duplicate values', () => {
    expect(new Set(values).size).toBe(values.length)
  })
})

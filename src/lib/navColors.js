/**
 * Top-nav colours, in one place so their contrast is testable (PR-3, HQ 2026-09-25).
 *
 * Inactive tabs were #4a5568 on the #0A0B0D header — 2.62:1, under WCAG AA (4.5:1). Mac reported
 * CONTENT / PLAN / REELS as hard to read on mobile. test/navContrast.test.js asserts every text
 * colour here against NAV_BG, so a future "subtler grey" cannot quietly fall back below AA.
 */
export const NAV_BG = '#0A0B0D'
export const NAV_INACTIVE = '#94A3B8'   // slate-400 — 7.68:1 on NAV_BG
export const NAV_ACTIVE = '#FFFFFF'     // 19.69:1 on NAV_BG
export const NAV_ACTIVE_PILL = 'rgba(255,255,255,0.10)'

/** WCAG 2.x relative luminance of a #rrggbb colour. */
export function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/** WCAG contrast ratio between two #rrggbb colours (1..21). */
export function contrastRatio(a, b) {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

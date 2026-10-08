/** "CLASS_PROMO" / "educational_tip" -> "Class promo" / "Educational tip". Display only (UX 2b). */
export function humanizeType(t) {
  const s = String(t || '').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return s ? s[0].toUpperCase() + s.slice(1) : ''
}

/**
 * The "Check before posting" flag (WO-4, spec v0.7 D4). One place for the label and the
 * approved reason lines, so the modal and the delivery view can't drift apart.
 *
 * The reworked generator delivers every post. When it isn't clean after the single refine, the
 * delivery row carries quality_flag=true plus a reason code (flag_reason) and, for banned_phrase,
 * the phrase (flag_phrase). Rows written before that change have no flag fields at all, so absent
 * or null always reads as "not flagged".
 *
 * Doctrine (§3): critic output is internal. Nothing here, or anywhere in the app, renders critic
 * notes. And no copy may promise that a person will check the post.
 */

export const FLAG_TITLE = 'Check before posting'

// Approved wording: v2, picked by Mac 2026-10-05 (replaces spec v0.7 §2 D4's lines). Change only
// with HQ approval. The delivery email (Render Delivery Email, generator) must match; it still
// carries the v0.7 lines until its own change ships after the WO-4 watch closes.
const LINES = {
  banned_phrase: (phrase) => `Contains a phrase we avoid: '${phrase}'. Edit it or regenerate.`,
  quality_unresolved: () => "Didn't fully pass our quality check. Give it a read, or regenerate.",
  error_fallback: () => "Our quality check didn't finish, so this is the first draft. Give it a read, or regenerate.",
}

/**
 * The one reason line for a flag. An unknown code, or banned_phrase without a phrase (the line
 * would read "flagged: ''"), falls back to the quality_unresolved line: still approved copy, and
 * it claims nothing specific.
 */
export function flagReasonLine(reason, phrase) {
  if (reason === 'banned_phrase') {
    const p = typeof phrase === 'string' ? phrase.trim() : ''
    return p ? LINES.banned_phrase(p) : LINES.quality_unresolved()
  }
  if (reason === 'error_fallback') return LINES.error_fallback()
  return LINES.quality_unresolved()
}

/** True only for an explicit quality_flag === true. Rows without the field are not flagged. */
export function isFlagged(delivery) {
  return !!delivery && delivery.quality_flag === true
}

/**
 * Whether to OFFER Regenerate. The proxy is the authority (it re-checks all of this server-side,
 * N2); this only keeps the button off where it would be refused. A regenerate is never offered
 * on a regenerate, so the chain stops at one.
 */
export function canOfferRegenerate(delivery, { alreadyRegenerated = false } = {}) {
  return isFlagged(delivery) && delivery.regenerated_from == null && !alreadyRegenerated
}

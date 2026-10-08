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

// A regenerate that is still flagged (Mac 2026-10-08, UX ruling 2a). There is no second
// Regenerate (one per original), so these lines must not point at one. All three approved by Mac
// 2026-10-08; change only with HQ approval. The delivery email still says "or regenerate" here
// until its own copy change ships (UX ruling 3).
const SECOND_PASS_LINES = {
  banned_phrase: (phrase) => `Contains a phrase we avoid: '${phrase}'. We've already given this one a second pass, so edit that line before you post.`,
  quality_unresolved: () => "We've already given this one a second pass. Have a read and tweak anything that doesn't sound like you.",
  error_fallback: () => "Our quality check didn't finish on this second pass. Have a read and tweak anything that doesn't sound like you.",
}

// What the Regenerate sheet says before the run (UX ruling 2a). An intent, never a guarantee (a
// regenerate can still be flagged), and never that a person will check it. Approved by Mac
// 2026-10-08; change only with HQ approval.
const INTRO_LINES = {
  banned_phrase: (phrase) => `We'll write a fresh version and steer clear of '${phrase}'.`,
  quality_unresolved: () => "We'll write a fresh version and run it through our quality check again.",
  error_fallback: () => "We'll write a fresh version and run our quality check on it.",
}

// One code-resolution rule for every line set. banned_phrase without a phrase (the line would
// read "avoid: ''") falls back to quality_unresolved, which is still true: the post did fail a
// check. An unknown or null code also falls back to it.
function pick(lines, reason, phrase) {
  if (reason === 'banned_phrase') {
    const p = typeof phrase === 'string' ? phrase.trim() : ''
    return p ? lines.banned_phrase(p) : lines.quality_unresolved()
  }
  if (reason === 'error_fallback') return lines.error_fallback()
  return lines.quality_unresolved()
}

/**
 * The one reason line for a flag. `secondPass`: the flagged post is itself a regenerate, so the
 * line offers no Regenerate. The generator emits only the three codes, and a delivered_flagged
 * row with any other reason trips Sentinel's wo4_watch flag_mismatch alert, so the fallback is a
 * monitored anomaly, not normal copy.
 */
export function flagReasonLine(reason, phrase, { secondPass = false } = {}) {
  return pick(secondPass ? SECOND_PASS_LINES : LINES, reason, phrase)
}

/** The Regenerate sheet's opening line for a flagged original. */
export function regenerateIntroLine(reason, phrase) {
  return pick(INTRO_LINES, reason, phrase)
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

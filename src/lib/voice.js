/**
 * The ONE definition of "this studio has no brand voice" (AG-1.1d).
 *
 * Empty means null, undefined, the empty string, or whitespace only. Every consumer asks this
 * question the same way: the first-login voice gate (lib/deepLink voiceGateRedirect), the
 * Generate button in GenerateModal, and the setup screen's Save button. The generator's own
 * backstop (`Assert Prompt Fields`) and the Stranded Alert's reason field run in n8n and cannot
 * import this; they must match it, and `VOICE_CASES` is the fixed list they are checked against.
 *
 * A copy that drifts fails in the quiet direction — a whitespace-only voice treated as "set"
 * routes an owner past setup into a Generate button that the generator then refuses.
 */
export function isVoiceEmpty(voice) {
  if (voice === null || voice === undefined) return true
  return String(voice).trim() === ''
}

/**
 * Fixed agreement cases for any re-implementation of isVoiceEmpty (n8n Code nodes, SQL).
 * [input, expectedEmpty]. SQL equivalent: coalesce(btrim(v, E' \t\r\n'), '') = ''.
 */
export const VOICE_CASES = [
  [null, true],
  [undefined, true],
  ['', true],
  [' ', true],
  ['   \t\n\r ', true],
  ['a', false],
  ['  Energetic and real.  ', false],
  ['\nWarm, no jargon.\n', false],
]

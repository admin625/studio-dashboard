/**
 * The one wait estimate (UX ruling 2b, Mac 2026-10-08). The app said three different things about
 * the same run: "Ready within 20 minutes" under the button, "about a minute, longer with AI
 * images" while it ran, and "Each AI image adds ~1 minute" in the form. Measured runs on
 * 2026-10-08: 81 s (3 posts with images) and 92 s (regenerate); the proxy's own answer comes at
 * ~22 s. Surfaces: the Create form, the Regenerate sheet, the waiting screen, the Deliveries
 * banner, and the photo editor's AI photo line.
 *
 * `withPhotos`: true, false, or unknown (undefined). Unknown gets the longer line, which is true
 * either way.
 */
export function waitLine(withPhotos) {
  return withPhotos === false ? 'Usually takes about a minute.' : 'Usually a minute or two.'
}

/**
 * When a run counts as "taking longer than expected". Must sit OUTSIDE the range waitLine promises:
 * at 90 s (the old value) a normal 92 s run would already be told to contact support.
 */
export const TAKING_LONGER_MS = 150_000

/**
 * The one wait estimate (UX ruling 2b, Mac 2026-10-08). The app said three different things about
 * the same run: "Ready within 20 minutes" under the button, "about a minute, longer with AI
 * images" while it ran, and "Each AI image adds ~1 minute" in the form. Measured runs on
 * 2026-10-08: 81 s (3 posts with images) and 92 s (regenerate); the proxy's own answer comes at
 * ~22 s. Every surface now takes its line from here.
 *
 * `withPhotos`: true, false, or unknown (undefined). Unknown gets the longer line, which is true
 * either way.
 */
export function waitLine(withPhotos) {
  return withPhotos === false ? 'Usually takes about a minute.' : 'Usually a minute or two.'
}

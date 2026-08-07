/**
 * Append Supabase Storage's `download` param to a photo URL.
 *
 * WHY: the HTML `download` attribute is IGNORED for cross-origin URLs. Photo URLs
 * are Supabase Storage (a different origin from app.fiorsaoirse.com), so the
 * browser drops the attribute and just navigates. On desktop `target="_blank"`
 * disguises it — the image opens in a tab and you right-click → Save. On mobile
 * there is no right-click, so there is no download at all. Same code, same
 * behaviour, different affordance: it reads as a mobile bug and isn't one.
 *
 * `?download` makes Storage send `Content-Disposition: attachment` server-side,
 * which DOES work cross-origin.
 *
 * Separator is computed, never assumed. Katie's 83 photos are all unsigned
 * `/object/public/` URLs with no query string, so `?` is right for those — but
 * `currentPhotoUrl` can also be a watermarked override, and a signed URL already
 * carries `?token=`. Appending `?` to that would corrupt the signature and turn a
 * broken download into a broken image.
 */
export function withDownloadParam(url, filename) {
  if (!url || typeof url !== 'string') return url
  // Nothing to attach for inline data — and appending would corrupt the payload.
  if (/^(data|blob):/i.test(url)) return url

  const hashAt = url.indexOf('#')
  const base = hashAt === -1 ? url : url.slice(0, hashAt)
  const frag = hashAt === -1 ? '' : url.slice(hashAt)

  if (/[?&]download(=|$)/.test(base)) return url // already set — don't double it

  const sep = base.includes('?') ? '&' : '?'
  const param = filename ? 'download=' + encodeURIComponent(filename) : 'download'
  return base + sep + param + frag
}

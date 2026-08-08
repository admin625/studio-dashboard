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
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic']

/** Slug a string for use in a filename: lowercase, ASCII, hyphen-joined. */
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Extension from a URL, allowlisted. A storage path can end in anything, and an
 * unvalidated tail becomes the filename extension the browser acts on — so a
 * junk segment must fall back rather than pass through.
 */
function extFromUrl(url) {
  const bare = String(url || '').split('#')[0].split('?')[0]
  const last = bare.slice(bare.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  if (dot === -1) return '.jpg'
  const ext = last.slice(dot + 1).toLowerCase()
  return IMAGE_EXTS.includes(ext) ? '.' + ext : '.jpg'
}

/**
 * Human-readable download name for a post photo.
 *
 * AI-generated photos are stored under a bare epoch object name, so `?download`
 * alone hands the customer "1785846633924.jpg". This builds something that says
 * whose it is and when it was taken.
 *
 * Disambiguation uses `index` — the position of the post within its platform tab —
 * NOT post_number. post_number is the obvious choice and is NULL on 62% of posts,
 * so it would collapse siblings into one name for most deliveries. Position always
 * exists. Same reasoning as keying an aggregate on array ordinality.
 */
export function photoDownloadName({ studioName, platform, index, url, date } = {}) {
  const studio = slug(studioName) || 'fca-studio'
  const d = (date instanceof Date && !isNaN(date) ? date : new Date()).toISOString().slice(0, 10)
  const parts = [studio, d]
  const plat = slug(platform)
  if (plat) parts.push(plat)
  if (Number.isFinite(index)) parts.push(String(index + 1))
  return parts.join('-') + extFromUrl(url)
}

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

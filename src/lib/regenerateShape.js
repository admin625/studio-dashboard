/**
 * The shape of a delivery, so a Regenerate asks for what the original was (UX ruling 2a,
 * Mac 2026-10-08). Before this the Regenerate button opened the full Create form at its defaults
 * (3 posts, images on): TLK's 1-post flagged delivery c8787c0a came back as 3 posts on 10-06.
 *
 * Read from the delivery row the browser already holds: one entry per platform whose content is a
 * non-empty array. count = posts delivered (clamped to the proxy's 1–5); images = any post carries
 * a photo_url. The request itself is not readable from the browser, so both are inferred: an
 * images-ON run whose image step produced nothing reads as images-off, a photo swapped in after
 * delivery reads as images-on, and a short delivery reads as its delivered count. The sheet says
 * what it will ask for, so the owner sees it. Instagram format is not carried: the modal only
 * ever sends feed_post. Returns null when nothing usable is found
 * (a legacy object-shaped row, or no content): the caller then falls back to the full form, the
 * old behaviour, rather than guessing a shape.
 *
 * The topic of a freestyle original is not stored anywhere the app can read, so it is not part of
 * the shape. The sheet asks for it instead (optional).
 */

const CONTENT_KEYS = [
  ['instagram', 'instagram_content'],
  ['facebook', 'facebook_content'],
  ['twitter', 'twitter_content'],
  ['linkedin', 'linkedin_content'],
  ['tiktok', 'tiktok_content'],
]

const LABELS = { instagram: 'Instagram', facebook: 'Facebook', twitter: 'X', linkedin: 'LinkedIn', tiktok: 'TikTok' }

export function originalShape(delivery) {
  if (!delivery) return null
  const shape = {}
  for (const [name, key] of CONTENT_KEYS) {
    const posts = delivery[key]
    if (!Array.isArray(posts) || !posts.length) continue
    const real = posts.filter((p) => p && typeof p === 'object')
    if (!real.length) continue
    shape[name] = {
      count: Math.min(5, real.length),
      images: real.some((p) => typeof p.photo_url === 'string' && p.photo_url.trim() !== ''),
    }
  }
  return Object.keys(shape).length ? shape : null
}

/** "1 Instagram post with a photo", "3 Instagram posts with photos and 2 Facebook posts, no photos". */
export function describeShape(shape) {
  if (!shape) return ''
  const parts = Object.entries(shape).map(([name, { count, images }]) => {
    const posts = `${count} ${LABELS[name] || name} post${count === 1 ? '' : 's'}`
    const pics = images ? (count === 1 ? 'with a photo' : 'with photos') : 'no photos'
    return images ? `${posts} ${pics}` : `${posts}, ${pics}`
  })
  if (parts.length <= 1) return parts[0] || ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

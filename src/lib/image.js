/**
 * Client-side image helpers.
 */

/**
 * Downscale an image URL to `maxEdge` on its long side and return raw base64 (no data: prefix).
 *
 * The downscale is required, not cosmetic: studio photos are full-resolution stock (a measured
 * 5750x3840 / 1.91MB source base64s to ~2.43MB — 40% of Netlify's 6MB sync-function body limit
 * on a single image). 1024px lands roughly 10x smaller and leaves headroom for the rest of the
 * payload.
 *
 * Used by every EDIT path that binds a source image for the AI Photo Generator's Nano branch.
 */
export async function downscaleToBase64(url, maxEdge = 1024) {
  const blob = await (await fetch(url)).blob()
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
  if (bitmap.close) bitmap.close()
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
  const base64 = dataUrl.split(',')[1] || ''
  return { base64, mime: 'image/jpeg', w, h, approxBytes: Math.round(base64.length * 0.75) }
}

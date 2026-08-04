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

/**
 * Probe a logo for usable transparency, for the pre-watermark warning.
 *
 * Deliberately NOT a MIME check. A fully-opaque PNG stamps exactly the same solid block as a
 * JPEG, so "is it a PNG" is the wrong predicate — it would pass the bad file and produce a NEW
 * silent failure that looks fixed. The real predicate is "does this image actually have
 * transparent pixels", which needs the alpha channel.
 *
 * Note this cannot reuse downscaleToBase64: that encodes to image/jpeg, which flattens alpha
 * against black and would report every logo as opaque.
 *
 * Returns `ok: false` when transparency cannot be determined (decode failure, tainted canvas).
 * Callers MUST treat that as "unknown" and stay silent — a warning fired on a failed probe is a
 * false alarm on the owner's own correct file, which is worse than no warning at all.
 */
const _logoProbeCache = new Map()

export async function probeLogoAlpha(url, sampleEdge = 256) {
  if (_logoProbeCache.has(url)) return _logoProbeCache.get(url)
  const result = await _probeLogoAlphaUncached(url, sampleEdge)
  // Cache successes only. An `ok: false` is usually transient (offline, a slow bucket), and
  // caching it would silence the warning for the rest of the session on a genuinely bad logo.
  if (result.ok) _logoProbeCache.set(url, result)
  return result
}

async function _probeLogoAlphaUncached(url, sampleEdge) {
  const blob = await (await fetch(url)).blob()
  const type = (blob.type || '').toLowerCase()

  // SVG is vector with native transparency, and createImageBitmap support for it is inconsistent.
  // Probing it risks a false "opaque" on a perfectly good logo.
  if (type.includes('svg')) {
    return { ok: true, format: 'svg', opaque: false, transparentRatio: 1, w: 0, h: 0 }
  }
  // NOTE: JPEG is deliberately NOT short-circuited here even though its opacity is a format fact.
  // We still need the decode for real dimensions — a logo can be BOTH opaque AND too small, and
  // those need different remedies (re-export with transparency vs source a bigger file). Short-
  // circuiting returned w:0 and silently suppressed the size warning for exactly the population
  // most likely to need it.

  let bitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    return { ok: false, format: type || 'unknown' }
  }
  const srcW = bitmap.width
  const srcH = bitmap.height
  const scale = Math.min(1, sampleEdge / Math.max(srcW, srcH))
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  // Start fully transparent so we measure the image's own alpha, not a default fill.
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  if (bitmap.close) bitmap.close()

  let data
  try {
    data = ctx.getImageData(0, 0, w, h).data
  } catch {
    return { ok: false, format: type || 'unknown' } // tainted canvas — undetermined, not opaque
  }
  let notFullyOpaque = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) notFullyOpaque++
  const px = w * h
  return {
    ok: true,
    format: type || 'unknown',
    opaque: notFullyOpaque === 0,
    transparentRatio: px ? notFullyOpaque / px : 0,
    w: srcW,
    h: srcH,
  }
}

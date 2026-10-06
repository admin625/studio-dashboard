// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import {
  BUCKET_LIMIT_BYTES, PROJECT_LIMIT_BYTES, MAX_CLIP_BYTES,
  oversizeClips, oversizeMessage, limitMb, displayMb,
} from '../src/lib/uploadTelemetry'

/**
 * Reel upload size limit (Mac 2026-10-06).
 *
 * Storage enforces min(bucket, project). On 2026-09-03 Katie's 113.9 MB clip passed a gate that
 * only knew the 300 MiB bucket limit, uploaded for 559.7 s, and was then rejected because the
 * project limit was lower at the time. Measured today (read-only): bucket 'reel-sources'
 * 314572800 B, project fileSizeLimit 524288000 B (Pro plan), so the bucket binds.
 *
 * Controls, through the REAL NewReelModal: a just-over clip is refused at selection, before any
 * upload starts, with the limit in MB and what to do; a just-under clip uploads.
 */

const uploads = []
vi.mock('../src/lib/supabase', () => ({
  getSessionOnce: async () => ({ data: { session: { access_token: 'a.e30.s' } } }),
  supabase: {
    from: () => ({ insert: async () => ({ error: null }) }),
    storage: {
      from: (bucket) => ({
        upload: async (path, file) => { uploads.push({ bucket, path, size: file.size }); return { error: null } },
      }),
    },
  },
}))
vi.mock('../src/context/AppContext', () => ({ useApp: () => ({ role: 'studio_owner' }) }))

const STUDIO = '085fde09-d7f7-486f-89d6-d65fc1838ab0'

// A File whose reported size is set without allocating it: the gate only reads .size.
function clip(name, size) {
  const f = new File(['x'], name, { type: 'video/quicktime' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

describe('limits', () => {
  it('records both measured limits, and the gate is their minimum', () => {
    expect(BUCKET_LIMIT_BYTES).toBe(314572800)
    expect(PROJECT_LIMIT_BYTES).toBe(524288000)
    expect(MAX_CLIP_BYTES).toBe(Math.min(BUCKET_LIMIT_BYTES, PROJECT_LIMIT_BYTES))
    expect(MAX_CLIP_BYTES).toBe(314572800)
  })

  it('exactly the limit passes; one byte over is refused', () => {
    expect(oversizeClips([clip('a.mov', MAX_CLIP_BYTES)])).toHaveLength(0)
    expect(oversizeClips([clip('a.mov', MAX_CLIP_BYTES + 1)])).toHaveLength(1)
  })

  it('Katie\'s 09-03 clip (119396805 B) passes today: the bucket, not the project, binds', () => {
    expect(oversizeClips([clip('katie.mov', 119396805)])).toHaveLength(0)
  })

  it('the limit shown is whole decimal MB, rounded DOWN (never names a size the server rejects)', () => {
    expect(limitMb()).toBe('314')
    expect(Number(limitMb()) * 1e6).toBeLessThanOrEqual(MAX_CLIP_BYTES)
  })
})

describe('owner-facing message', () => {
  it('one clip: names it, its size in MB as the phone shows it, the limit in MB, and both fixes', () => {
    const m = oversizeMessage([clip('class.mov', 412_300_000)])
    expect(m).toBe('“class.mov” is 412.3 MB. Each clip can be up to 314 MB. ' +
      'Trim it, or export it at a lower quality (for example 1080p instead of 4K), then add it again.')
  })

  it('several clips: lists each with its size', () => {
    const m = oversizeMessage([clip('a.mov', 400e6), clip('b.mov', 350e6)])
    expect(m).toContain('2 clips are over the 314 MB limit per clip')
    expect(m).toContain('“a.mov” (400.0 MB)')
    expect(m).toContain('“b.mov” (350.0 MB)')
    expect(m).toMatch(/Trim them, or export them at a lower quality/)
  })

  it('a just-over clip reads as over in the message itself (314.6 MB vs 314 MB)', () => {
    expect(displayMb(MAX_CLIP_BYTES + 1)).toBe('314.6')
  })
})

describe('NewReelModal controls', () => {
  let NewReelModal
  beforeEach(async () => {
    uploads.length = 0
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}) }))
    ;({ default: NewReelModal } = await import('../src/components/NewReelModal.jsx'))
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const pick = (container, files) => {
    const input = container.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files } })
  }

  it('JUST OVER: refused at selection with the limit and what to do; nothing uploads', async () => {
    const { container } = render(<NewReelModal studioId={STUDIO} primary="#6d5dfc" onClose={() => {}} onCreated={() => {}} />)
    pick(container, [clip('just-over.mov', MAX_CLIP_BYTES + 1)])
    expect(screen.getByText(/“just-over\.mov” is 314\.6 MB\. Each clip can be up to 314 MB\./)).toBeTruthy()
    expect(screen.getByText(/export it at a lower quality/)).toBeTruthy()
    // The selection is cleared, so Create stays disabled and no upload can start.
    const create = screen.getByRole('button', { name: /Create reel/ })
    expect(create.disabled).toBe(true)
    await act(async () => { fireEvent.click(create) })
    expect(uploads).toHaveLength(0)
  })

  it('JUST UNDER (exactly the limit): no error, and Create uploads it to reel-sources', async () => {
    const { container } = render(<NewReelModal studioId={STUDIO} primary="#6d5dfc" onClose={() => {}} onCreated={() => {}} />)
    pick(container, [clip('just-under.mov', MAX_CLIP_BYTES)])
    expect(screen.queryByText(/Each clip can be up to/)).toBeNull()
    const create = screen.getByRole('button', { name: /Create reel/ })
    expect(create.disabled).toBe(false)
    await act(async () => { fireEvent.click(create) })
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({ bucket: 'reel-sources', size: MAX_CLIP_BYTES })
    expect(uploads[0].path.startsWith(STUDIO + '/')).toBe(true)
  })

  it('a mix: one over refuses the whole pick (nothing uploads), and names only the over clip', async () => {
    const { container } = render(<NewReelModal studioId={STUDIO} primary="#6d5dfc" onClose={() => {}} onCreated={() => {}} />)
    pick(container, [clip('ok.mov', 10e6), clip('big.mov', MAX_CLIP_BYTES + 5e6)])
    expect(screen.getByText(/“big\.mov”/)).toBeTruthy()
    expect(screen.queryByText(/“ok\.mov”/)).toBeNull()
    expect(uploads).toHaveLength(0)
  })
})

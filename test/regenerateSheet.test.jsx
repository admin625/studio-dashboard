// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

/**
 * UX ruling 2a (Mac 2026-10-08): Regenerate asks for the ORIGINAL's shape.
 * Seen live: TLK 10-06, a 1-post flagged delivery regenerated as 3 posts (17f9fac3), and HAL's
 * 10-08 walkthrough (0cd5a6d9, 1 post, no images → 4a4c400e, 3 posts with images), because the
 * button opened the full Create form at its defaults. These drive the REAL modal to the request
 * it sends. Negative control: with no shape the full form is still there (the old path).
 */

vi.mock('../src/lib/supabase', () => ({
  getSessionOnce: async () => ({ data: { session: { access_token: 'tok' } } }),
  supabase: { rpc: async () => ({ data: [{ outcome: null, outcome_detail: null, delivery_id: null }], error: null }) },
}))
const appState = {}
vi.mock('../src/context/AppContext', () => ({ useApp: () => appState }))

import GenerateModal from '../src/components/GenerateModal.jsx'

const ORIGINAL = '0cd5a6d9-1b27-4238-a6e9-9e96a10cf10c'
let bodies
beforeEach(() => {
  Object.keys(appState).forEach((k) => delete appState[k])
  Object.assign(appState, {
    authReady: true, role: 'studio_owner', brandColorPrimary: '#bd8276', brandVoice: 'We are community-focused.',
    aiPhotoPrompt: '', studioLoadError: false, email: 'owner@example.com',
    resolvedStudioId: '085fde09-d7f7-486f-89d6-d65fc1838ab0', resolvedClientId: null,
    photoSource: 'ai_assist', studioName: 'Studio', studioType: 'studio', lastContentTypes: [],
  })
  bodies = []
  global.fetch = vi.fn(async (_u, opts) => { bodies.push(JSON.parse(opts.body)); return { ok: true, status: 202, json: async () => ({ success: true }) } })
})
const REAL_FETCH = global.fetch
afterEach(() => { cleanup(); global.fetch = REAL_FETCH })

const ui = (props) => (
  <MemoryRouter>
    <GenerateModal open onClose={() => {}} onSubmitted={() => {}} regenerateOf={ORIGINAL} {...props} />
  </MemoryRouter>
)
const ONE_NO_IMG = { instagram: { count: 1, images: false } }
const write = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /write a new version/i })) }) }

describe('Regenerate sheet', () => {
  it("asks for the original's shape: 1 Instagram post, no images, and names the reason", async () => {
    render(ui({ regenerateShape: ONE_NO_IMG, regenerateReason: { reason: 'banned_phrase', phrase: 'no excuses' } }))
    expect(screen.getByText("We'll write a fresh version and steer clear of 'no excuses'.")).toBeTruthy()
    expect(screen.getByText('Same as before: 1 Instagram post, no photos.')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull() // no post-count select to drift from
    await write()
    expect(bodies).toHaveLength(1)
    expect(bodies[0].regenerate_of).toBe(ORIGINAL)
    expect(bodies[0].platforms).toEqual([{ name: 'instagram', postCount: 1, includeImages: false, formats: ['feed_post'] }])
    expect(bodies[0]).not.toHaveProperty('freestyle')
  })

  it('a multi-platform original keeps every platform and count, and nothing else', async () => {
    render(ui({ regenerateShape: { instagram: { count: 2, images: true }, linkedin: { count: 1, images: false } } }))
    await write()
    expect(bodies[0].platforms).toEqual([
      { name: 'instagram', postCount: 2, includeImages: true, formats: ['feed_post'] },
      { name: 'linkedin', postCount: 1, includeImages: false },
    ])
  })

  it('an optional topic is sent as a freestyle prompt; blank sends none', async () => {
    render(ui({ regenerateShape: ONE_NO_IMG }))
    fireEvent.change(screen.getByLabelText(/anything this post should be about/i), { target: { value: 'October music themes' } })
    await write()
    expect(bodies[0].freestyle).toBe(true)
    expect(bodies[0].freestyle_prompt).toBe('October music themes')
    expect(bodies[0].platforms[0].postCount).toBe(1)
  })

  it('a topic typed then cleared is not freestyle', async () => {
    render(ui({ regenerateShape: ONE_NO_IMG }))
    const t = screen.getByLabelText(/anything this post should be about/i)
    fireEvent.change(t, { target: { value: 'x' } })
    fireEvent.change(t, { target: { value: '  ' } })
    await write()
    expect(bodies[0]).not.toHaveProperty('freestyle')
  })

  it('a new shape object each render does not wipe a topic being typed', () => {
    const { rerender } = render(ui({ regenerateShape: { ...ONE_NO_IMG } }))
    fireEvent.change(screen.getByLabelText(/anything this post should be about/i), { target: { value: 'keep me' } })
    rerender(ui({ regenerateShape: { instagram: { ...ONE_NO_IMG.instagram } } }))
    expect(screen.getByLabelText(/anything this post should be about/i).value).toBe('keep me')
  })

  it('reopen: a platform the original did not use is OFF, and the topic is cleared', async () => {
    const closed = (props) => (
      <MemoryRouter><GenerateModal open={false} onClose={() => {}} onSubmitted={() => {}} regenerateOf={ORIGINAL} {...props} /></MemoryRouter>
    )
    const { rerender } = render(ui({ regenerateShape: { instagram: { count: 1, images: false }, linkedin: { count: 1, images: false } } }))
    fireEvent.change(screen.getByLabelText(/anything this post should be about/i), { target: { value: 'old topic' } })
    rerender(closed({ regenerateShape: ONE_NO_IMG }))
    rerender(ui({ regenerateShape: ONE_NO_IMG }))
    expect(screen.getByLabelText(/anything this post should be about/i).value).toBe('')
    await write()
    expect(bodies[0].platforms.map(p => p.name)).toEqual(['instagram'])
    expect(bodies[0]).not.toHaveProperty('freestyle')
  })

  it('a shape that CHANGES mid-open does not reset the sheet (only the open transition does)', () => {
    const { rerender } = render(ui({ regenerateShape: ONE_NO_IMG }))
    fireEvent.change(screen.getByLabelText(/anything this post should be about/i), { target: { value: 'keep me' } })
    rerender(ui({ regenerateShape: { instagram: { count: 2, images: true } } }))
    expect(screen.getByLabelText(/anything this post should be about/i).value).toBe('keep me')
  })

  it('no brand voice: the button is disabled and the hint names the button on screen', () => {
    appState.brandVoice = ''
    render(ui({ regenerateShape: ONE_NO_IMG }))
    expect(screen.getByRole('button', { name: /write a new version/i }).disabled).toBe(true)
    const hint = screen.getByRole('note')
    expect(hint.textContent).toMatch(/^Write a new version needs your studio's brand voice/)
    expect(hint.textContent).not.toMatch(/create content/i)
  })

  it('waits for the slot lookup: disabled until ready, then sends the slot', async () => {
    const { rerender } = render(ui({ regenerateShape: ONE_NO_IMG, regenerateReady: false, slotId: 'slot-1', slotDate: '2026-10-10' }))
    expect(screen.getByRole('button', { name: /write a new version/i }).disabled).toBe(true)
    rerender(ui({ regenerateShape: ONE_NO_IMG, regenerateReady: true, slotId: 'slot-1', slotDate: '2026-10-10' }))
    await write()
    expect(bodies[0].slot_id).toBe('slot-1')
  })

  it('a slot-bound regenerate offers no topic box (the slot decides the post)', () => {
    render(ui({ regenerateShape: ONE_NO_IMG, slotId: 'slot-1', slotDate: '2026-10-10' }))
    expect(screen.queryByLabelText(/anything this post should be about/i)).toBeNull()
    cleanup()
    render(ui({ regenerateShape: ONE_NO_IMG }))
    expect(screen.getByLabelText(/anything this post should be about/i)).toBeTruthy()
  })

  it('the wait line follows the shape: photos take longer', () => {
    render(ui({ regenerateShape: { instagram: { count: 1, images: true } } }))
    expect(screen.getByText('Usually a minute or two.')).toBeTruthy()
    cleanup()
    render(ui({ regenerateShape: ONE_NO_IMG }))
    expect(screen.getByText('Usually takes about a minute.')).toBeTruthy()
  })

  it('negative control: with no shape, the full form is shown (old path) at its defaults', () => {
    render(ui({ regenerateShape: null }))
    expect(screen.getByText('Regenerate this post')).toBeTruthy()
    expect(screen.getAllByRole('combobox')[0].value).toBe('3')
    expect(screen.queryByTestId('regenerate-sheet')).toBeNull()
  })
})

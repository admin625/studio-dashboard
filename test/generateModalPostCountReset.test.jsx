// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Katie polish (HQ 2026-09-29, A3): GenerateModal stays mounted while closed, so a post count
 * picked for one run stuck on every later open until a reload. Seen live 2026-10-01: after a
 * 1-post run, the reopened modal still read "1 posts". Every open must start at the default.
 * Negative control: WITHOUT a close/reopen the chosen count stays, so the reset is the open
 * transition and not a re-render that would also eat a choice mid-form.
 */
vi.mock('../src/lib/supabase', () => ({
  getSessionOnce: async () => ({ data: { session: { access_token: 'tok' } } }),
  supabase: { rpc: async () => ({ data: [], error: null }), from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) },
}))
vi.mock('../src/context/AppContext', () => ({
  useApp: () => ({
    authReady: true, role: 'studio_owner', brandColorPrimary: '#bd8276', brandVoice: 'We are community-focused.',
    aiPhotoPrompt: '', studioLoadError: false, email: 'owner@example.com',
    resolvedStudioId: '085fde09-d7f7-486f-89d6-d65fc1838ab0', resolvedClientId: 'f896e176-ee81-4a7f-9414-500caba002fd',
    photoSource: 'studio_only', studioName: 'Studio', studioType: 'studio', lastContentTypes: [],
  }),
}))

import GenerateModal, { DEFAULT_POST_COUNT } from '../src/components/GenerateModal.jsx'

afterEach(cleanup)

const ui = (open) => (
  <MemoryRouter><GenerateModal open={open} onClose={() => {}} onSubmitted={() => {}} /></MemoryRouter>
)
const igSelect = () => screen.getAllByRole('combobox')[0]
const box = (name) => screen.getByRole('checkbox', { name: new RegExp(name, 'i') })

describe('GenerateModal post count resets on every open', () => {
  it('the default is 3, matching the select and the proxy clamp range', () => {
    expect(DEFAULT_POST_COUNT).toBe(3)
  })

  it('a count chosen before close is back to the default after reopen', () => {
    const { rerender } = render(ui(true))
    expect(igSelect().value).toBe(String(DEFAULT_POST_COUNT))
    fireEvent.change(igSelect(), { target: { value: '1' } })
    expect(igSelect().value).toBe('1')
    rerender(ui(false))
    rerender(ui(true))
    expect(igSelect().value).toBe(String(DEFAULT_POST_COUNT))
  })

  it('negative control: without a close/reopen the chosen count stays', () => {
    const { rerender } = render(ui(true))
    fireEvent.change(igSelect(), { target: { value: '5' } })
    rerender(ui(true))
    expect(igSelect().value).toBe('5')
  })

  it('only the count resets: a platform switched on stays on, at the default count', () => {
    const { rerender } = render(ui(true))
    fireEvent.click(box('facebook'))
    const fb = () => screen.getAllByRole('combobox')[1]
    fireEvent.change(fb(), { target: { value: '2' } })
    rerender(ui(false))
    rerender(ui(true))
    expect(box('facebook').checked).toBe(true)
    expect(fb().value).toBe(String(DEFAULT_POST_COUNT))
  })
})

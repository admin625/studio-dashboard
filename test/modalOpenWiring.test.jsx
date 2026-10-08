// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

/**
 * 2c review: the help bubble and phone tab bar step aside while a modal is open, which only works
 * if the REAL modals register. These mount the real ones and read the counter.
 */
vi.mock('../src/lib/supabase', () => ({ getSessionOnce: async () => ({ data: { session: null } }), supabase: { rpc: async () => ({ data: [], error: null }) } }))
vi.mock('../src/context/AppContext', () => ({
  useApp: () => ({ authReady: true, role: 'studio_owner', brandColorPrimary: '#bd8276', brandVoice: 'v', studioLoaded: true, resolvedStudioId: 's', studioName: 'S', email: 'o@x.test', aiPhotoPrompt: '', photoSource: 'ai_assist' }),
}))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ logout: async () => {} }) }))

const { modalOpenCount } = await import('../src/lib/modalOpen.js')
const { default: GenerateModal } = await import('../src/components/GenerateModal.jsx')
const { SlotPanel } = await import('../src/pages/Calendar.jsx')
afterEach(cleanup)

describe('real modals register with the open counter', () => {
  it('GenerateModal: open counts, closed does not (negative control)', () => {
    const ui = (open) => <MemoryRouter><GenerateModal open={open} onClose={() => {}} /></MemoryRouter>
    const { rerender } = render(ui(false))
    expect(modalOpenCount()).toBe(0)
    rerender(ui(true))
    expect(modalOpenCount()).toBe(1)
    rerender(ui(false))
    expect(modalOpenCount()).toBe(0)
  })

  it('SlotPanel: mounted = open; unmounted = released', () => {
    const slot = { id: 's1', slot_date: '2026-10-10', job: 'class_traffic', job_label: 'Into class', reason: 'r', status: 'planned' }
    const { unmount } = render(<SlotPanel slot={slot} primary="#bd8276" onClose={() => {}} onAct={() => {}} onReason={() => {}} onGenerate={() => {}} />)
    expect(modalOpenCount()).toBe(1)
    unmount()
    expect(modalOpenCount()).toBe(0)
  })
})

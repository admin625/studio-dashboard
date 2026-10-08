// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

/**
 * UX ruling 2c (Mac 2026-10-08), from the 10-08 walkthrough at 390x844:
 *  - the six tabs needed ~570px; Reels/Photos/Brand/Account sat behind a swipe
 *  - the help bubble covered the slot sheet's "Skip this one" and the Create footer
 *  - the Create button sat at y=851, under the fold, inside a body that scrolled separately
 *  - Edit caption / Edit hashtags were hover-only (invisible on a phone) and 15px tall
 * Phone width is driven through matchMedia, the same signal the app reads.
 */
vi.mock('../src/context/AppContext', () => ({
  useApp: () => ({ email: 'o@x.test', role: 'studio_owner', studioName: 'Mac Test Studio v2', brandColorPrimary: '#bd8276', authReady: true }),
}))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ signOut: vi.fn() }) }))
vi.mock('../src/lib/supabase', () => ({ supabase: {}, getSessionOnce: async () => ({ data: { session: null } }) }))

let mmListeners = new Set()
let phoneNow = false
const setPhone = (on) => {
  phoneNow = on
  window.matchMedia = vi.fn().mockImplementation((q) => ({
    get matches() { return phoneNow && /max-width: 639px/.test(q) }, media: q,
    addEventListener: (_e, l) => mmListeners.add(l), removeEventListener: (_e, l) => mmListeners.delete(l),
    addListener: (l) => mmListeners.add(l), removeListener: (l) => mmListeners.delete(l),
  }))
}
const rotate = (on) => act(() => { phoneNow = on; mmListeners.forEach((l) => l()) })

const { default: Layout } = await import('../src/components/Layout.jsx')
const { default: HelpChatWidget } = await import('../src/components/HelpChatWidget.jsx')
const { useModalOpen, modalOpenCount } = await import('../src/lib/modalOpen.js')

function FakeModal({ open }) { useModalOpen(open); return null }

const REAL_MM = window.matchMedia
afterEach(() => { cleanup(); window.matchMedia = REAL_MM; mmListeners = new Set() })

describe('phone nav: a bottom bar with every tab', () => {
  it('at phone width: all six tabs in the bottom bar, no swipe row, the studio name up top', () => {
    setPhone(true)
    render(<MemoryRouter initialEntries={['/calendar']}><Layout><div /></Layout></MemoryRouter>)
    const bar = screen.getByTestId('nav-bottom')
    const links = [...bar.querySelectorAll('a')].map((a) => a.textContent)
    expect(links).toEqual(['Content', 'Plan', 'Reels', 'Photos', 'Brand', 'Account'])
    expect(bar.querySelector('[aria-current="page"]').textContent).toBe('Plan')
    expect(screen.queryByTestId('nav-tabs')).toBeNull()
    expect(document.body.textContent).toContain('Mac Test Studio v2')
    for (const a of bar.querySelectorAll('a')) expect(a.style.minHeight).toBe('56px')
    expect(document.querySelector('main').className).toContain('pb-36')
  })

  it('negative control: at desktop width the top row stays and there is no bottom bar', () => {
    setPhone(false)
    render(<MemoryRouter initialEntries={['/calendar']}><Layout><div /></Layout></MemoryRouter>)
    expect(screen.getByTestId('nav-tabs')).toBeTruthy()
    expect(screen.queryByTestId('nav-bottom')).toBeNull()
  })

  it('Sign out is a 44px target', () => {
    setPhone(true)
    render(<MemoryRouter><Layout><div /></Layout></MemoryRouter>)
    const b = screen.getByRole('button', { name: /sign out/i })
    expect(b.className).toContain('min-h-[44px]')
    expect(b.className).toContain('min-w-[44px]')
  })
})

describe('help bubble', () => {
  it('steps aside while any modal is open and comes back after; the count never goes negative', () => {
    setPhone(false)
    const { rerender } = render(<><HelpChatWidget currentPage="calendar" /><FakeModal open={false} /></>)
    expect(screen.getByTitle('Help')).toBeTruthy()
    rerender(<><HelpChatWidget currentPage="calendar" /><FakeModal open /></>)
    expect(screen.queryByTitle('Help')).toBeNull()
    rerender(<><HelpChatWidget currentPage="calendar" /><FakeModal open={false} /></>)
    expect(screen.getByTitle('Help')).toBeTruthy()
    expect(modalOpenCount()).toBe(0)
  })

  it('two modals: closing one does not bring it back while the other is open', () => {
    setPhone(false)
    const { rerender } = render(<><HelpChatWidget currentPage="x" /><FakeModal open /><FakeModal open /></>)
    rerender(<><HelpChatWidget currentPage="x" /><FakeModal open={false} /><FakeModal open /></>)
    expect(screen.queryByTitle('Help')).toBeNull()
  })

  it('it lifts above the bar only while the bar is really there', () => {
    setPhone(true)
    render(<MemoryRouter><Layout><div /></Layout><HelpChatWidget currentPage="x" /></MemoryRouter>)
    expect(screen.getByTitle('Help').style.bottom).toBe('88px')
    cleanup()
    // a phone page without Layout (e.g. /reels/upload) has no bar: no lift
    render(<HelpChatWidget currentPage="x" />)
    expect(screen.getByTitle('Help').style.bottom).toBe('24px')
    cleanup()
    setPhone(false)
    render(<MemoryRouter><Layout><div /></Layout><HelpChatWidget currentPage="x" /></MemoryRouter>)
    expect(screen.getByTitle('Help').style.bottom).toBe('24px')
  })
})

describe('2c review: the bar and real modals', () => {
  it('the bottom bar steps aside while a modal is open (it painted over the slot sheet at z-50)', () => {
    setPhone(true)
    const { rerender } = render(<MemoryRouter initialEntries={['/calendar']}><Layout><FakeModal open={false} /></Layout></MemoryRouter>)
    expect(screen.getByTestId('nav-bottom')).toBeTruthy()
    rerender(<MemoryRouter initialEntries={['/calendar']}><Layout><FakeModal open /></Layout></MemoryRouter>)
    expect(screen.queryByTestId('nav-bottom')).toBeNull()
    rerender(<MemoryRouter initialEntries={['/calendar']}><Layout><FakeModal open={false} /></Layout></MemoryRouter>)
    expect(screen.getByTestId('nav-bottom')).toBeTruthy()
  })

  it('rotating across 640px swaps the bottom bar and the top row (the listener is live)', () => {
    setPhone(false)
    render(<MemoryRouter><Layout><div /></Layout></MemoryRouter>)
    expect(screen.getByTestId('nav-tabs')).toBeTruthy()
    rotate(true)
    expect(screen.getByTestId('nav-bottom')).toBeTruthy()
    expect(screen.queryByTestId('nav-tabs')).toBeNull()
    rotate(false)
    expect(screen.queryByTestId('nav-bottom')).toBeNull()
  })

  it('an OPEN chat also steps aside for a modal, and comes back with what was typed', () => {
    setPhone(false)
    const { rerender } = render(<><HelpChatWidget currentPage="x" /><FakeModal open={false} /></>)
    fireEvent.click(screen.getByTitle('Help'))
    const field = () => document.querySelector('input, textarea')
    fireEvent.change(field(), { target: { value: 'how do I add an instructor' } })
    rerender(<><HelpChatWidget currentPage="x" /><FakeModal open /></>)
    expect(field()).toBeNull()
    expect(screen.queryByTitle('Help')).toBeNull()
    rerender(<><HelpChatWidget currentPage="x" /><FakeModal open={false} /></>)
    expect(field().value).toBe('how do I add an instructor')
  })
})

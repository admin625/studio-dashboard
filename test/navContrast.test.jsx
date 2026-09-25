// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { NAV_BG, NAV_INACTIVE, NAV_ACTIVE, contrastRatio } from '../src/lib/navColors'

/**
 * PR-3 (HQ 2026-09-25): top-nav tab text was #4a5568 on #0A0B0D — 2.62:1. WCAG AA for normal text is
 * 4.5:1. These pin the colours AND that Layout actually renders them, so the ratio is about what ships.
 */
vi.mock('../src/context/AppContext', () => ({ useApp: () => ({ email: 'o@x.test', role: 'studio_owner', studioName: 'Studio', brandColorPrimary: '#bd8276', authReady: true }) }))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ signOut: vi.fn() }) }))
import Layout from '../src/components/Layout.jsx'

const rgbToHex = (s) => '#' + s.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()

afterEach(cleanup)

describe('nav contrast (WCAG AA)', () => {
  it('computes the known reference ratios', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1)
    expect(contrastRatio('#4A5568', '#0A0B0D')).toBeCloseTo(2.62, 1) // the old, failing value
  })
  it('inactive and active tab text are at least 4.5:1 on the header', () => {
    expect(contrastRatio(NAV_INACTIVE, NAV_BG)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(NAV_ACTIVE, NAV_BG)).toBeGreaterThanOrEqual(4.5)
  })
  it('Layout renders inactive tabs in NAV_INACTIVE on NAV_BG, and the active tab distinctly', () => {
    render(<MemoryRouter initialEntries={['/calendar']}><Layout><div /></Layout></MemoryRouter>)
    const nav = document.querySelector('nav')
    expect(rgbToHex(nav.style.background)).toBe(NAV_BG.toUpperCase())
    const content = screen.getByRole('link', { name: /content/i })
    const plan = screen.getByRole('link', { name: /plan/i })
    expect(rgbToHex(content.style.color)).toBe(NAV_INACTIVE.toUpperCase())
    expect(content.getAttribute('aria-current')).toBeNull()
    expect(rgbToHex(plan.style.color)).toBe(NAV_ACTIVE.toUpperCase())
    expect(plan.getAttribute('aria-current')).toBe('page')
    expect(plan.style.boxShadow).toMatch(/inset/)            // underline marks the active tab
    expect(content.style.boxShadow).not.toMatch(/inset/)
    expect(rgbToHex(screen.getByRole('button', { name: /sign out/i }).style.color)).toBe(NAV_INACTIVE.toUpperCase())
  })
})

describe('PR-4: mobile nav reachability + no sub-AA greys left', () => {
  it('every tab lives inside the scroll container (the page never widens for the nav)', () => {
    render(<MemoryRouter initialEntries={['/calendar']}><Layout><div /></Layout></MemoryRouter>)
    const row = screen.getByTestId('nav-tabs')
    expect(row.className).toMatch(/overflow-x-auto/)
    for (const t of ['Content', 'Plan', 'Reels', 'Photos', 'Brand', 'Account']) {
      expect(row.contains(screen.getByRole('link', { name: new RegExp(t, 'i') }))).toBe(true)
    }
  })
  it('shows the right-edge hint when more tabs are off-screen, and the left one after scrolling to the end', async () => {
    render(<MemoryRouter initialEntries={['/calendar']}><Layout><div /></Layout></MemoryRouter>)
    const row = screen.getByTestId('nav-tabs')
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 430 })
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 250 })
    Object.defineProperty(row, 'scrollLeft', { configurable: true, writable: true, value: 0 })
    await act(async () => { fireEvent.scroll(row) })
    expect(screen.queryByTestId('nav-more-right')).not.toBeNull()
    expect(screen.queryByTestId('nav-more-left')).toBeNull()
    row.scrollLeft = 180
    await act(async () => { fireEvent.scroll(row) })
    expect(screen.queryByTestId('nav-more-right')).toBeNull()
    expect(screen.queryByTestId('nav-more-left')).not.toBeNull()
  })
  it('the failing grey #4a5568 (2.62:1) is not used as a colour anywhere in src', () => {
    const hits = []
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(jsx?|css)$/.test(f.name)) { fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/#4a5568/i.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)) hits.push(p + ':' + (i + 1)) }) } } }
    walk(path.resolve(__dirname, '../src'))
    expect(hits).toEqual([])
  })
})

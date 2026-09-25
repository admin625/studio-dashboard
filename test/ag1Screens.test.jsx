// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/**
 * AG-1 PR-1 screens, asserted AT THE CONTROL (spec v0.9 acceptance):
 *   AG-1.1b  setup shows the three prompts verbatim, cannot save an empty voice, saves the voice
 *            WITHOUT touching colour/font, then goes to Content. No skip control exists.
 *   AG-1.2   a failed save is visible, keeps every character typed, and retries.
 *   AG-1.4   the /login link button sends shouldCreateUser:false to the pinned origin and shows
 *            the SAME message whether or not the address exists.
 * The failure mode in every case is silence, which a return-value test cannot see.
 */

let appState
const saveBrand = vi.fn()
const signInWithOtp = vi.fn()

vi.mock('../src/context/AppContext', () => ({ useApp: () => appState }))
vi.mock('../src/hooks/useBrandSettings', () => ({
  useBrandSettings: () => ({ saveBrand, saveStudioType: vi.fn(), savePhotoSource: vi.fn(), savePhotoPrompt: vi.fn(), uploadLogo: vi.fn(), uploadLogoVariant: vi.fn() }),
}))
vi.mock('../src/components/Layout', () => ({ default: ({ children }) => <div data-testid="layout">{children}</div> }))
vi.mock('../src/lib/supabase', () => ({
  supabase: { auth: { signInWithOtp: (...a) => signInWithOtp(...a), signInWithPassword: vi.fn(), signOut: vi.fn() } },
  SUPABASE_URL: 'https://example.supabase.co',
  getSessionOnce: vi.fn(),
}))

import VoiceSetup, { VOICE_PROMPTS } from '../src/pages/VoiceSetup.jsx'
import BrandSettings from '../src/pages/BrandSettings.jsx'
import Login from '../src/pages/Login.jsx'

const baseApp = {
  authReady: true, studioLoaded: true, studioLoadError: false, role: 'studio_owner', user: null,
  brandVoice: '', brandColorPrimary: '#bd8276', brandColorSecondary: '#111111', brandFont: 'Inter',
  brandLogoUrl: '', brandLogoLightUrl: '', brandLogoDarkUrl: '', photoSource: 'ai_assist', aiPhotoPrompt: '', studioType: '',
  update: vi.fn(), reset: vi.fn(),
}

function renderAt(path, element) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path.split('?')[0]} element={element} />
        <Route path="/deliveries" element={<div>CONTENT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => { appState = { ...baseApp }; saveBrand.mockReset(); signInWithOtp.mockReset() })
afterEach(cleanup)

describe('AG-1.1b voice setup', () => {
  it('shows the three K1a prompts verbatim, and no skip control', () => {
    renderAt('/setup/voice', <VoiceSetup />)
    expect(VOICE_PROMPTS).toEqual([
      'Who are you and what do you teach?',
      'How do you describe your classes to a first-timer?',
      "Any words you'd never use?",
    ])
    for (const p of VOICE_PROMPTS) expect(screen.getByText(p)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /skip|later|not now/i })).toBeNull()
  })

  it('cannot save an empty or whitespace-only voice', () => {
    renderAt('/setup/voice', <VoiceSetup />)
    const save = screen.getByRole('button', { name: /save and continue/i })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/brand voice/i), { target: { value: '   \n ' } })
    expect(save.disabled).toBe(true)
  })

  it('saves the voice with colour and font passed back unchanged, then goes to Content', async () => {
    saveBrand.mockResolvedValue(undefined)
    renderAt('/setup/voice', <VoiceSetup />)
    fireEvent.change(screen.getByLabelText(/brand voice/i), { target: { value: 'Warm, no jargon.' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save and continue/i })) })
    expect(saveBrand).toHaveBeenCalledWith({ brandColorPrimary: '#bd8276', brandColorSecondary: '#111111', brandFont: 'Inter', brandVoice: 'Warm, no jargon.' })
    expect(screen.getByText('CONTENT PAGE')).toBeTruthy()
  })

  it('a failed save is visible, keeps the text, and retries', async () => {
    saveBrand.mockRejectedValueOnce(new Error('saveBrand timed out')).mockResolvedValueOnce(undefined)
    renderAt('/setup/voice', <VoiceSetup />)
    const field = screen.getByLabelText(/brand voice/i)
    fireEvent.change(field, { target: { value: 'Bold and direct.' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save and continue/i })) })
    expect(screen.getByRole('alert').textContent).toMatch(/didn't save/i)
    expect(field.value).toBe('Bold and direct.')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save and continue/i })) })
    expect(saveBrand).toHaveBeenCalledTimes(2)
    expect(screen.getByText('CONTENT PAGE')).toBeTruthy()
  })

  it('does not render the form before hydration (saveBrand writes every brand field)', () => {
    appState = { ...baseApp, studioLoaded: false }
    renderAt('/setup/voice', <VoiceSetup />)
    expect(screen.queryByLabelText(/brand voice/i)).toBeNull()
  })

  it('sends a non-owner away instead of offering a form she cannot own', () => {
    appState = { ...baseApp, role: 'studio_instructor' }
    renderAt('/setup/voice', <VoiceSetup />)
    expect(screen.getByText('CONTENT PAGE')).toBeTruthy()
  })
})

describe('AG-1.2 Brand Settings save error', () => {
  it('a failed save shows an error, keeps the input, and the button retries', async () => {
    appState = { ...baseApp, brandVoice: 'Old voice.' }
    saveBrand.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(undefined)
    renderAt('/brand', <BrandSettings />)
    const field = screen.getByDisplayValue('Old voice.')
    fireEvent.change(field, { target: { value: 'New voice, typed carefully.' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save brand settings/i })) })
    expect(screen.getByRole('alert').textContent).toMatch(/didn't save/i)
    expect(field.value).toBe('New voice, typed carefully.')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again/i })) })
    expect(saveBrand).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: /saved/i })).toBeTruthy()
  })
})

describe('AG-1.4 Part 1 /login sign-in link', () => {
  const typeEmail = (v) => fireEvent.change(screen.getByPlaceholderText('you@studio.com'), { target: { value: v } })
  const clickLink = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /email me a sign-in link/i })) }) }

  beforeEach(() => { appState = { ...baseApp, authReady: true, user: null } })

  it('calls signInWithOtp with shouldCreateUser:false and the pinned callback origin', async () => {
    signInWithOtp.mockResolvedValue({ error: null })
    renderAt('/login?next=%2Fcalendar', <Login />)
    typeEmail('owner@studio.com')
    await clickLink()
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'owner@studio.com',
      options: { emailRedirectTo: 'https://app.fiorsaoirse.com/auth/callback?next=%2Fcalendar', shouldCreateUser: false },
    })
  })

  it('an unknown address gets exactly the same message as a known one', async () => {
    signInWithOtp.mockResolvedValueOnce({ error: null })
    renderAt('/login', <Login />)
    typeEmail('known@studio.com'); await clickLink()
    const known = screen.getByRole('status').textContent
    cleanup()
    signInWithOtp.mockResolvedValueOnce({ error: { status: 422, code: 'otp_disabled', message: 'Signups not allowed for otp' } })
    renderAt('/login', <Login />)
    typeEmail('nobody@nowhere.test'); await clickLink()
    expect(screen.getByRole('status').textContent).toBe(known)
  })

  it('the 60s limit says wait; any other failure is visible', async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { status: 429, message: 'For security purposes, you can only request this after 51 seconds.' } })
    renderAt('/login', <Login />)
    typeEmail('owner@studio.com'); await clickLink()
    expect(screen.getByRole('status').textContent).toMatch(/wait a minute/i)
    signInWithOtp.mockResolvedValueOnce({ error: { status: 500, message: 'Error sending magic link email' } })
    await clickLink()
    expect(screen.getByRole('status').textContent).toMatch(/couldn't send/i)
  })

  it('asks for an email instead of calling the API with none', async () => {
    renderAt('/login', <Login />)
    await clickLink()
    expect(signInWithOtp).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toMatch(/enter your email/i)
  })
})

import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Loader2, ChevronRight, ArrowRight } from 'lucide-react'
import Layout from '../components/Layout'
import { useApp } from '../context/AppContext'
import { useBrandSettings } from '../hooks/useBrandSettings'
import { isVoiceEmpty } from '../lib/voice'
import { isOwnerRole } from '../lib/role'
import { VOICE_EXAMPLES, ExampleCard } from './BrandSettings'

/**
 * AG-1.1b — first-login voice setup. ProtectedRoute sends an owner here (lib/deepLink
 * voiceGateRedirect) until her studio has a stored brand voice. No skip (HQ B3): without a voice
 * the generator refuses, so every other screen would be a dead end dressed as a working product.
 *
 * The three prompts are guidance only (K1a, spec v0.8/v0.9). Answers go into the single
 * `brand_voice` field exactly as Brand Settings stores it — no new storage, and the empty-voice
 * predicate is unchanged.
 */
export const VOICE_PROMPTS = [
  'Who are you and what do you teach?',
  'How do you describe your classes to a first-timer?',
  "Any words you'd never use?",
]

export default function VoiceSetup() {
  const { authReady, studioLoaded, studioLoadError, role } = useApp()

  // Same order as BrandSettings: error first, then hydration. saveBrand writes all four brand fields
  // from app state, so saving before hydration would blank a studio's colours and font.
  if (studioLoadError) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center gap-2 py-32 text-center">
          <p className="text-sm font-semibold text-[#475569]">Couldn't load your studio.</p>
          <p className="text-xs text-[#94A3B8]">Refresh to try again. Nothing has been changed.</p>
        </div>
      </Layout>
    )
  }
  if (!authReady || !studioLoaded) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-32">
          <Loader2 size={22} className="animate-spin" style={{ color: '#94A3B8' }} />
        </div>
      </Layout>
    )
  }
  // Instructors cannot set the studio voice; send them to their normal home.
  if (!isOwnerRole(role)) return <Navigate to="/deliveries" replace />
  return <VoiceSetupForm />
}

export function VoiceSetupForm() {
  const app = useApp()
  const navigate = useNavigate()
  const { saveBrand } = useBrandSettings()
  const primary = app.brandColorPrimary || '#667eea'
  const [voice, setVoice] = useState(app.brandVoice || '')
  const [showExamples, setShowExamples] = useState(false)
  const [state, setState] = useState('idle') // idle | saving | error

  const empty = isVoiceEmpty(voice)

  const handleSave = async () => {
    if (empty || state === 'saving') return
    setState('saving')
    try {
      // saveBrand writes colour, secondary, font and voice together. Pass the stored values back
      // untouched so this screen changes the voice and nothing else.
      await saveBrand({
        brandColorPrimary: app.brandColorPrimary,
        brandColorSecondary: app.brandColorSecondary,
        brandFont: app.brandFont,
        brandVoice: voice,
      })
      navigate('/deliveries', { replace: true })
    } catch (e) {
      // AG-1.2 behaviour here too: say so, keep what she typed, let her retry.
      console.error('[VoiceSetup] Save failed:', e)
      setState('error')
    }
  }

  return (
    <Layout>
      <div className="max-w-2xl mx-auto py-8 sm:py-12" style={{ fontFamily: "'DM Sans', -apple-system, sans-serif" }}>
        <p className="text-[11px] font-semibold tracking-[0.2em] uppercase mb-3" style={{ color: primary }}>First step</p>
        <h1 className="text-[#0A0B0D] leading-none mb-4" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 'clamp(2.2rem, 6vw, 3.4rem)', letterSpacing: '0.02em' }}>
          Your Studio's Voice
        </h1>
        <p className="text-[#475569] text-sm leading-relaxed mb-6">
          Before FCA writes anything, it needs to sound like you. Answer these in your own words, in the box below.
        </p>

        <ol className="mb-5 space-y-2" aria-label="Voice prompts">
          {VOICE_PROMPTS.map((p, i) => (
            <li key={p} className="flex gap-3 text-sm text-[#1e293b]">
              <span className="font-bold" style={{ color: primary }}>{i + 1}.</span>
              <span>{p}</span>
            </li>
          ))}
        </ol>

        <label htmlFor="voice-setup-field" className="block text-xs font-bold tracking-wider uppercase text-[#475569] mb-2">
          Brand voice
        </label>
        <textarea
          id="voice-setup-field"
          value={voice}
          onChange={e => { setVoice(e.target.value); if (state === 'error') setState('idle') }}
          rows={6}
          placeholder="e.g. Energetic and real — we're not a fancy studio, we're a community. We speak like a coach who actually cares."
          className="w-full px-5 py-4 border-2 border-black/10 bg-white text-[#1e293b] text-sm leading-relaxed focus:outline-none placeholder:text-[#CBD5E1] resize-y mb-3"
        />

        <button type="button" onClick={() => setShowExamples(v => !v)}
          className="flex items-center gap-2 text-[11px] font-bold tracking-[0.12em] uppercase mb-4" style={{ color: primary }}>
          <ChevronRight size={14} style={{ transform: showExamples ? 'rotate(90deg)' : 'none' }} />
          See examples by studio type
        </button>
        {showExamples && (
          <div className="grid sm:grid-cols-2 gap-3 mb-6">
            {VOICE_EXAMPLES.map(ex => <ExampleCard key={ex.studio} example={ex} brandColor={primary} onUse={setVoice} />)}
          </div>
        )}

        {state === 'error' && (
          <p role="alert" className="mb-4 px-4 py-3 rounded-lg text-sm font-semibold" style={{ background: 'rgba(239,68,68,0.08)', color: '#B91C1C' }}>
            Your voice didn't save. What you typed is still here — press Save again.
          </p>
        )}

        <button type="button" onClick={handleSave} disabled={empty || state === 'saving'}
          className="w-full sm:w-auto flex items-center justify-center gap-3 px-8 py-4 font-bold uppercase tracking-widest text-sm text-white disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: primary }}>
          {state === 'saving' ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : <>Save and continue <ArrowRight size={16} /></>}
        </button>
        {empty && (
          <p className="text-xs text-[#94A3B8] mt-3">Write at least a few words to continue. You can change it any time in Brand Settings.</p>
        )}
      </div>
    </Layout>
  )
}

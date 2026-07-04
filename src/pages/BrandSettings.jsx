/**
 * BrandSettings.jsx — FCA Studio Agent
 * Magazine Spread design: bold editorial sections alternating dark/light,
 * giant bleed numbers, asymmetric hero, crosshatch texture.
 *
 * Wired to AppContext + useBrandSettings for all Supabase operations.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useBrandSettings } from '../hooks/useBrandSettings'
import Layout from '../components/Layout'
import {
  Leaf, Zap, Disc3, Shield, BarChart3, Pencil,
  Palette, Type, MessageSquare, ImagePlus,
  Camera, Upload, Check, ChevronRight,
  ArrowRight, RotateCcw, Sparkles, Loader2,
} from 'lucide-react'

/* ── Helpers ── */
function isLight(hex = '#000') {
  hex = hex.replace('#', '')
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2]
  if (hex.length !== 6) return false
  const r = parseInt(hex.substr(0,2),16), g = parseInt(hex.substr(2,2),16), b = parseInt(hex.substr(4,2),16)
  return (r*299 + g*587 + b*114)/1000 > 155
}

const DARK = '#0A0B0D'
const LIGHT = '#F4F3EF'

const CROSSHATCH = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M0 24L24 0M-6 6L6-6M18 30L30 18' stroke='%23000' stroke-width='1' stroke-opacity='0.12'/%3E%3C/svg%3E")`

/* ── Constants ── */
const STUDIO_TYPES = [
  { value: 'yoga_pilates', label: 'YOGA /\nPILATES', sub: 'Mindful movement', Icon: Leaf },
  { value: 'hiit_crossfit', label: 'HIIT /\nCROSSFIT', sub: 'Maximum output', Icon: Zap },
  { value: 'dance_barre', label: 'DANCE /\nBARRE', sub: 'Grace & strength', Icon: Disc3 },
  { value: 'martial_arts', label: 'MARTIAL\nARTS', sub: 'Discipline first', Icon: Shield },
  { value: 'general_fitness', label: 'GENERAL\nFITNESS', sub: 'All-around power', Icon: BarChart3 },
  { value: 'custom', label: 'SOMETHING\nELSE', sub: 'Tell us your style', Icon: Pencil },
]
const KNOWN_TYPES = STUDIO_TYPES.filter(t => t.value !== 'custom').map(t => t.value)

const FONTS = [
  { value: '', label: 'Default (System)' },
  { value: 'Montserrat', label: 'Montserrat' },
  { value: 'Poppins', label: 'Poppins' },
  { value: 'Playfair Display', label: 'Playfair Display' },
  { value: 'Raleway', label: 'Raleway' },
  { value: 'Oswald', label: 'Oswald' },
  { value: 'Lato', label: 'Lato' },
  { value: 'Roboto', label: 'Roboto' },
  { value: 'Open Sans', label: 'Open Sans' },
  { value: 'Bebas Neue', label: 'Bebas Neue' },
]

const PHOTO_SOURCES = [
  { value: 'studio_only', Icon: Camera, label: 'STUDIO ONLY', sub: 'Your photos, always.' },
  { value: 'ai_assist', Icon: Sparkles, label: 'AI ASSIST', sub: 'Your shots first, AI fills gaps.' },
  { value: 'ai_only', Icon: ImagePlus, label: 'AI ONLY', sub: 'Fully generated, every time.' },
]

const VOICE_EXAMPLES = [
  { Icon: Leaf, studio: 'Yoga / Mindfulness', text: 'Warm, grounding, and inclusive. We speak like a trusted friend — calm, encouraging, never preachy. We celebrate small wins and meet people where they are.' },
  { Icon: Zap, studio: 'HIIT / CrossFit', text: "Bold, direct, and motivating. We don't sugarcoat — we push. High energy, community-driven, a little gritty. We celebrate hard work and results." },
  { Icon: Disc3, studio: 'Barre / Dance', text: 'Elegant, aspirational, and empowering. We speak with grace and confidence. Our community is strong, refined, and supports each other.' },
  { Icon: Shield, studio: 'Martial Arts', text: 'Disciplined, respectful, and empowering. We speak with authority but warmth. We build confidence and character, not just technique.' },
]

const PHOTO_EXAMPLES = [
  { Icon: Leaf, studio: 'Yoga / Mindfulness', text: 'Soft natural light, peaceful expressions, diverse practitioners, wood floors and plants, calm and grounded mood, earth tones' },
  { Icon: Zap, studio: 'HIIT / CrossFit', text: 'High contrast lighting, athletes mid-rep, sweaty and intense, dark industrial background, bold and motivational, high energy' },
  { Icon: Disc3, studio: 'Barre / Dance', text: 'Elegant studio setting, ballet barres and mirrors, graceful movement, pastel tones, feminine and refined mood, aspirational' },
  { Icon: Shield, studio: 'Martial Arts', text: 'Action shots, focused expressions, traditional gi or athletic gear, clean dojo background, disciplined and powerful mood' },
]

/* ── Section component ── */
function Section({ num, dark, brandColor, kicker, headline, children }) {
  const ghostSide = num % 2 === 1 ? { right: '-0.12em' } : { left: '-0.12em' }
  return (
    <div className="relative overflow-hidden" style={{ background: dark ? DARK : LIGHT }}>
      <span
        aria-hidden="true"
        className="absolute select-none pointer-events-none leading-none"
        style={{
          fontFamily: "'Bebas Neue', sans-serif",
          fontSize: 'clamp(220px, 28vw, 340px)',
          color: dark ? '#fff' : '#000',
          opacity: dark ? 0.035 : 0.045,
          top: '-0.15em',
          letterSpacing: '-0.02em',
          ...ghostSide,
        }}
      >
        {String(num).padStart(2, '0')}
      </span>
      <div className="relative z-10 px-6 sm:px-10 lg:px-16 py-14">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-px" style={{ background: brandColor }} />
          <span className="text-[10px] font-semibold tracking-[0.18em] uppercase" style={{ color: brandColor }}>
            {String(num).padStart(2, '0')} — {kicker}
          </span>
        </div>
        <h2
          className={`mb-8 leading-none ${dark ? 'text-white' : 'text-[#0A0B0D]'}`}
          style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 'clamp(2rem, 5vw, 3rem)', letterSpacing: '0.02em' }}
        >
          {headline}
        </h2>
        {children}
      </div>
    </div>
  )
}

function Divider({ brandColor }) {
  return <div className="h-px w-full" style={{ background: brandColor, opacity: 0.25 }} />
}

function ExampleCard({ example, onUse, brandColor }) {
  return (
    <button
      type="button"
      onClick={() => onUse(example.text)}
      className="group relative text-left p-4 border transition-all duration-200 rounded-none hover:-translate-y-0.5"
      style={{ borderColor: 'rgba(0,0,0,0.1)', background: '#fff' }}
    >
      <div className="flex items-center gap-2 mb-2">
        <example.Icon size={12} style={{ color: brandColor }} />
        <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: brandColor }}>
          {example.studio}
        </span>
      </div>
      <p className="text-xs text-[#475569] leading-relaxed italic group-hover:text-[#1e293b] transition-colors">
        "{example.text}"
      </p>
      <div className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: brandColor }}>
        <ArrowRight size={12} />
      </div>
    </button>
  )
}

/* ══════════════════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════════════════ */
export default function BrandSettings() {
  const { authReady, studioLoadError } = useApp()

  // Gate the entire form on studio-data hydration. AuthProvider sets the brand
  // fields and authReady in the same context update, so authReady === true
  // guarantees the stored brand values are present. Mounting BrandSettingsForm
  // (and therefore allowing a Save) before that would let the form's defaults
  // overwrite real stored values — e.g. writing black over a studio's secondary
  // color (the pre-hydration race fixed 2026-07-04).
  if (!authReady) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-32">
          <Loader2 size={22} className="animate-spin" style={{ color: '#94A3B8' }} />
        </div>
      </Layout>
    )
  }
  if (studioLoadError) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center gap-2 py-32 text-center">
          <p className="text-sm font-semibold text-[#475569]">Couldn't load your brand settings.</p>
          <p className="text-xs text-[#94A3B8]">Refresh to try again — we won't show the form until your saved brand loads, so nothing gets overwritten.</p>
        </div>
      </Layout>
    )
  }
  return <BrandSettingsForm />
}

function BrandSettingsForm() {
  const app = useApp()
  const { saveBrand, saveStudioType, savePhotoSource, savePhotoPrompt, uploadLogo, uploadLogoVariant } = useBrandSettings()

  const [primary, setPrimary] = useState(app.brandColorPrimary || '#667eea')
  const [secondary, setSecondary] = useState(app.brandColorSecondary || '')
  const [font, setFont] = useState(app.brandFont || '')
  const [voice, setVoice] = useState(app.brandVoice || '')
  const [logoUrl, setLogoUrl] = useState(app.brandLogoUrl || '')
  const [logoLightUrl, setLogoLightUrl] = useState(app.brandLogoLightUrl || '')
  const [logoDarkUrl, setLogoDarkUrl] = useState(app.brandLogoDarkUrl || '')
  const [photoSrc, setPhotoSrc] = useState(app.photoSource || 'studio_only')
  const [prompt, setPrompt] = useState(app.aiPhotoPrompt || '')
  const [studioTyp, setStudioTyp] = useState(app.studioType || '')
  const [showVoice, setShowVoice] = useState(false)
  const [showPhoto, setShowPhoto] = useState(false)
  const [saveState, setSaveState] = useState('idle')
  const [customType, setCustomType] = useState('')
  const promptTimer = useRef(null)
  const customTimer = useRef(null)
  const fileRef = useRef(null)
  const lightFileRef = useRef(null)
  const darkFileRef = useRef(null)

  // Sync from AppContext when it changes (e.g., after initial load)
  useEffect(() => {
    if (app.brandColorPrimary && primary === '#667eea') setPrimary(app.brandColorPrimary)
    if (app.brandColorSecondary && secondary === '') setSecondary(app.brandColorSecondary)
    if (app.brandFont) setFont(app.brandFont)
    if (app.brandVoice) setVoice(app.brandVoice)
    if (app.brandLogoUrl) setLogoUrl(app.brandLogoUrl)
    if (app.brandLogoLightUrl) setLogoLightUrl(app.brandLogoLightUrl)
    if (app.brandLogoDarkUrl) setLogoDarkUrl(app.brandLogoDarkUrl)
    if (app.photoSource) setPhotoSrc(app.photoSource)
    if (app.aiPhotoPrompt) setPrompt(app.aiPhotoPrompt)
    if (app.studioType) {
      if (KNOWN_TYPES.includes(app.studioType)) {
        setStudioTyp(app.studioType)
      } else {
        setStudioTyp('custom')
        setCustomType(app.studioType)
      }
    }
  }, [app.brandColorPrimary, app.brandColorSecondary, app.brandFont, app.brandVoice, app.brandLogoUrl, app.brandLogoLightUrl, app.brandLogoDarkUrl, app.photoSource, app.aiPhotoPrompt, app.studioType]) // eslint-disable-line

  // Font loader
  useEffect(() => {
    if (!font) return
    const id = 'gfont-' + font.replace(/\s/g, '-')
    if (document.getElementById(id)) return
    const link = document.createElement('link')
    link.id = id; link.rel = 'stylesheet'
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400;700&display=swap`
    document.head.appendChild(link)
  }, [font])

  // Progress
  const typeComplete = studioTyp && (studioTyp !== 'custom' || customType.trim())
  const filled = [typeComplete, primary !== '#667eea' && primary, font, voice.trim().length > 8, logoUrl].filter(Boolean).length
  const pct = Math.round((filled / 5) * 100)

  // Handlers
  const handleSave = async () => {
    // Defense-in-depth: BrandSettings won't mount this form pre-hydration, but
    // never let a Save fire against un-hydrated defaults.
    if (!app.authReady) return
    setSaveState('saving')
    try {
      await saveBrand({ brandColorPrimary: primary, brandColorSecondary: secondary, brandFont: font, brandVoice: voice })
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 3000)
    } catch (e) {
      console.error('[Brand] Save failed:', e)
      setSaveState('idle')
    }
  }

  const handleStudioType = async (val) => {
    setStudioTyp(val)
    if (val === 'custom') {
      // Don't save yet — wait for custom input
      if (customType) {
        try { await saveStudioType(customType) } catch (e) { console.warn(e) }
      }
    } else {
      setCustomType('')
      try { await saveStudioType(val) } catch (e) { console.warn(e) }
    }
  }

  const handleCustomType = (val) => {
    setCustomType(val)
    clearTimeout(customTimer.current)
    customTimer.current = setTimeout(async () => {
      if (val.trim()) {
        try { await saveStudioType(val.trim()) } catch (e) { console.warn(e) }
      }
    }, 800)
  }

  const handlePhotoSrc = async (val) => {
    setPhotoSrc(val)
    try { await savePhotoSource(val) } catch (e) { console.warn(e) }
  }

  const handlePrompt = useCallback((val) => {
    setPrompt(val)
    clearTimeout(promptTimer.current)
    promptTimer.current = setTimeout(async () => {
      try { await savePhotoPrompt(val) } catch (e) { console.warn(e) }
    }, 800)
  }, [savePhotoPrompt])

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Instant preview
    const reader = new FileReader()
    reader.onload = ev => setLogoUrl(ev.target.result)
    reader.readAsDataURL(file)
    try { await uploadLogo(file) } catch (err) { console.error('[Logo]', err) }
  }

  const handleVariantUpload = async (e, variant) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Instant preview
    const reader = new FileReader()
    reader.onload = ev => (variant === 'light' ? setLogoLightUrl(ev.target.result) : setLogoDarkUrl(ev.target.result))
    reader.readAsDataURL(file)
    try { await uploadLogoVariant(file, variant) } catch (err) { console.error('[LogoVariant]', variant, err) }
  }

  const saveBtnBg = saveState === 'saved' ? '#10B981' : primary

  return (
    <Layout>
      <div
        className="overflow-hidden rounded-2xl mb-8"
        style={{ fontFamily: "'DM Sans', -apple-system, sans-serif", boxShadow: '0 4px 40px rgba(0,0,0,0.14)' }}
      >
        {/* ═══ HERO ═══ */}
        <div className="relative flex flex-col sm:flex-row overflow-hidden" style={{ minHeight: 280 }}>
          {/* Left — brand color panel */}
          <div className="relative sm:w-[42%] flex-shrink-0 flex flex-col justify-end p-8 sm:p-10 min-h-[160px]" style={{ background: primary }}>
            <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: CROSSHATCH }} />
            <div className="hidden sm:block absolute top-0 right-0 h-full w-16 z-10" style={{ background: `linear-gradient(to bottom right, ${primary} 50%, ${DARK} 50%)` }} />
            <span aria-hidden="true" className="absolute top-4 left-6 leading-none select-none pointer-events-none font-black"
              style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 'clamp(100px, 16vw, 180px)', color: isLight(primary) ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)' }}>
              FCA
            </span>
            <div className="relative z-20">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full mb-3"
                style={{ background: isLight(primary) ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.15)', color: isLight(primary) ? DARK : '#fff' }}>
                <span className="text-[11px] font-semibold tracking-wide">BRAND SETUP</span>
                <span className="text-[11px] font-black" style={{ fontFamily: "'Bebas Neue', sans-serif" }}>{pct}%</span>
              </div>
              <div className="w-full max-w-[180px] h-1 rounded-full overflow-hidden" style={{ background: isLight(primary) ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.2)' }}>
                <div className="h-full rounded-full transition-all duration-700" style={{ width: pct + '%', background: isLight(primary) ? 'rgba(0,0,0,0.5)' : '#fff' }} />
              </div>
              <p className="mt-2 text-[11px] font-medium" style={{ color: isLight(primary) ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)' }}>{filled}/5 fields</p>
            </div>
          </div>
          {/* Right — dark, headline */}
          <div className="flex-1 flex flex-col justify-center px-8 sm:px-14 py-10" style={{ background: DARK }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-6 h-px" style={{ background: primary }} />
              <span className="text-[10px] font-semibold tracking-[0.2em] uppercase" style={{ color: primary }}>FCA Studio Agent</span>
            </div>
            <h1 className="text-white leading-none mb-4" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 'clamp(2.6rem, 6vw, 4.2rem)', letterSpacing: '0.025em' }}>
              Define Your<br /><span style={{ color: primary }}>Studio's DNA.</span>
            </h1>
            <p className="text-[#5A5E6B] text-sm leading-relaxed max-w-sm italic">
              The stronger your brand setup, the more FCA sounds like <em className="text-[#7A7E8B] not-italic font-medium">you</em>.
            </p>
          </div>
        </div>

        {/* ═══ 01 STUDIO TYPE ═══ */}
        <Section num={1} dark brandColor={primary} kicker="Studio Type" headline="What Kind of Beast Is Your Studio?">
          <p className="text-[#4A4E5A] text-sm leading-relaxed mb-8 max-w-lg">
            Your studio type shapes every piece of content FCA generates.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-white/[0.04]">
            {STUDIO_TYPES.map(t => {
              const sel = studioTyp === t.value
              return (
                <button key={t.value} type="button" onClick={() => handleStudioType(t.value)}
                  className="relative overflow-hidden border text-left transition-all duration-300 group p-5"
                  style={{ background: sel ? primary : DARK, borderColor: sel ? primary : 'rgba(255,255,255,0.08)', color: sel ? (isLight(primary) ? DARK : '#fff') : 'rgba(255,255,255,0.85)', minHeight: 130 }}>
                  <t.Icon size={22} className="mb-3" style={{ opacity: sel ? 1 : 0.5 }} />
                  <p className="leading-[1.1] font-black mb-1 whitespace-pre-line" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '1.25rem', letterSpacing: '0.04em' }}>{t.label}</p>
                  <p className="text-[11px] font-medium tracking-wide" style={{ opacity: sel ? 0.8 : 0.4 }}>{t.sub}</p>
                  {sel && <Check size={14} className="absolute top-3 right-3" />}
                </button>
              )
            })}
          </div>
          {studioTyp === 'custom' && (
            <div className="mt-4" style={{ animation: 'fade-up 0.25s ease both' }}>
              <p className="text-[10px] font-semibold tracking-[0.18em] uppercase mb-2" style={{ color: primary }}>
                Describe your studio type
              </p>
              <input
                type="text"
                value={customType}
                onChange={e => handleCustomType(e.target.value)}
                placeholder="e.g. Boxing, Cycling, Rowing, Functional Training..."
                autoFocus
                className="w-full px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none transition-all"
                style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderBottom: `2px solid ${primary}40`, borderRadius: 0 }}
                onFocus={e => (e.target.style.borderBottomColor = primary)}
                onBlur={e => (e.target.style.borderBottomColor = `${primary}40`)}
              />
              {customType.trim() && (
                <p className="text-xs mt-2" style={{ color: primary }}>
                  <Check size={11} className="inline mr-1" />Saved as "{customType.trim()}"
                </p>
              )}
            </div>
          )}
        </Section>

        <Divider brandColor={primary} />

        {/* ═══ 02 BRAND COLORS ═══ */}
        <Section num={2} dark={false} brandColor={primary} kicker="Brand Colors" headline="Your Palette. Your Power.">
          <p className="text-[#475569] text-sm leading-relaxed mb-8 max-w-lg">These colors paint every AI-generated image.</p>
          <div className="grid sm:grid-cols-2 gap-6 mb-8">
            {/* Primary */}
            <div>
              <p className="text-[10px] font-bold tracking-[0.16em] uppercase mb-3" style={{ color: DARK }}>Primary</p>
              <div className="flex items-stretch gap-3">
                <label className="cursor-pointer flex-shrink-0">
                  <div className="w-16 h-14 border border-black/10 transition-transform hover:scale-105" style={{ background: primary }} />
                  <input type="color" value={primary} className="sr-only" onChange={e => setPrimary(e.target.value)} />
                </label>
                <input type="text" value={primary} maxLength={7} placeholder="#667eea"
                  onChange={e => setPrimary(e.target.value)}
                  className="flex-1 h-14 px-4 border border-black/10 bg-white text-sm font-mono text-[#0A0B0D] focus:outline-none uppercase" style={{ letterSpacing: '0.08em' }} />
              </div>
            </div>
            {/* Secondary */}
            <div>
              <p className="text-[10px] font-bold tracking-[0.16em] uppercase mb-3" style={{ color: DARK }}>Secondary</p>
              <div className="flex items-stretch gap-3">
                <label className="cursor-pointer flex-shrink-0">
                  <div className="w-16 h-14 border border-black/10 transition-transform hover:scale-105" style={{ background: secondary, border: isLight(secondary) ? '1px solid rgba(0,0,0,0.15)' : undefined }} />
                  <input type="color" value={secondary || '#0A0B0D'} className="sr-only" onChange={e => setSecondary(e.target.value)} />
                </label>
                <input type="text" value={secondary} maxLength={7} placeholder="#0A0B0D"
                  onChange={e => setSecondary(e.target.value)}
                  className="flex-1 h-14 px-4 border border-black/10 bg-white text-sm font-mono text-[#0A0B0D] focus:outline-none uppercase" style={{ letterSpacing: '0.08em' }} />
              </div>
            </div>
          </div>
          {/* Live palette */}
          <p className="text-[10px] font-bold tracking-[0.16em] uppercase mb-3" style={{ color: DARK }}>Live Preview</p>
          <div className="flex overflow-hidden" style={{ height: 64 }}>
            <div className="flex-1 flex items-center justify-center transition-all duration-300" style={{ background: primary, color: isLight(primary) ? DARK : '#fff', fontFamily: font ? `'${font}', sans-serif` : "'Bebas Neue', sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: '0.14em' }}>PRIMARY</div>
            <div className="w-px flex-shrink-0" style={{ background: 'rgba(255,255,255,0.2)' }} />
            <div className="flex-1 flex items-center justify-center transition-all duration-300" style={{ background: secondary, color: isLight(secondary) ? DARK : '#fff', fontFamily: font ? `'${font}', sans-serif` : "'Bebas Neue', sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: '0.14em', outline: isLight(secondary) ? '1px solid rgba(0,0,0,0.1)' : 'none' }}>SECONDARY</div>
          </div>
        </Section>

        <Divider brandColor={primary} />

        {/* ═══ 03 BRAND FONT ═══ */}
        <Section num={3} dark brandColor={primary} kicker="Brand Font" headline="The Way Your Studio Looks in Print.">
          <p className="text-[#4A4E5A] text-sm leading-relaxed mb-8 max-w-lg">Sets the typographic character for AI-generated graphics.</p>
          <div className="grid sm:grid-cols-2 gap-3 mb-8">
            {FONTS.map(f => (
              <button key={f.value} type="button" onClick={() => setFont(f.value)}
                className="flex items-center justify-between px-4 py-3 border text-left transition-all duration-200"
                style={{ background: font === f.value ? primary : 'transparent', borderColor: font === f.value ? primary : 'rgba(255,255,255,0.08)', color: font === f.value ? (isLight(primary) ? DARK : '#fff') : 'rgba(255,255,255,0.6)' }}>
                <span className="text-sm" style={{ fontFamily: f.value ? `'${f.value}', sans-serif` : 'inherit', fontSize: f.value === 'Bebas Neue' ? 17 : 14 }}>{f.label}</span>
                {font === f.value && <Check size={13} />}
              </button>
            ))}
          </div>
          <div className="relative overflow-hidden px-6 py-8" style={{ background: 'rgba(255,255,255,0.03)', borderLeft: `3px solid ${primary}` }}>
            <p className="text-[10px] font-semibold tracking-[0.2em] uppercase mb-4" style={{ color: primary }}>Live Preview</p>
            <p className="text-white leading-none transition-all duration-500" style={{ fontFamily: font ? `'${font}', sans-serif` : "'Bebas Neue', sans-serif", fontSize: 'clamp(2.5rem, 8vw, 6rem)', letterSpacing: font === 'Bebas Neue' || font === 'Oswald' ? '0.04em' : '-0.01em', fontWeight: font && font !== 'Bebas Neue' && font !== 'Oswald' ? 700 : 400 }}>
              {font === 'Playfair Display' ? 'Train hard. Live strong.' : 'TRAIN HARD. LIVE STRONG.'}
            </p>
            <p className="mt-4 text-sm transition-all duration-500" style={{ fontFamily: font ? `'${font}', sans-serif` : 'inherit', color: 'rgba(255,255,255,0.25)' }}>
              The quick brown fox jumps over the lazy dog
            </p>
          </div>
        </Section>

        <Divider brandColor={primary} />

        {/* ═══ 04 BRAND VOICE ═══ */}
        <Section num={4} dark={false} brandColor={primary} kicker="Brand Voice" headline="How Your Studio Talks.">
          <p className="text-[#475569] text-sm leading-relaxed mb-6 max-w-lg">
            This is your studio's personality in words — the energy, warmth, edge, or authority.
          </p>
          <textarea value={voice} onChange={e => setVoice(e.target.value)} rows={4}
            placeholder="e.g. Energetic and real — we're not a fancy studio, we're a community. We speak like a coach who actually cares."
            className="w-full px-5 py-4 border-2 border-black/10 bg-white text-[#1e293b] text-sm leading-relaxed focus:outline-none transition-colors placeholder:text-[#CBD5E1] resize-y mb-2"
            style={{ borderColor: voice ? `${primary}40` : undefined }}
            onFocus={e => (e.target.style.borderColor = `${primary}80`)} onBlur={e => (e.target.style.borderColor = voice ? `${primary}40` : 'rgba(0,0,0,0.1)')} />
          {voice && <p className="text-xs mb-4" style={{ color: primary }}><Check size={11} className="inline mr-1.5" />Voice captured</p>}
          <button type="button" onClick={() => setShowVoice(v => !v)} className="flex items-center gap-2 text-[11px] font-bold tracking-[0.12em] uppercase mb-4 transition-colors" style={{ color: primary }}>
            <ChevronRight size={14} className="transition-transform duration-200" style={{ transform: showVoice ? 'rotate(90deg)' : 'none' }} />
            See examples by studio type
          </button>
          {showVoice && (
            <div className="grid sm:grid-cols-2 gap-3">
              {VOICE_EXAMPLES.map(ex => <ExampleCard key={ex.studio} example={ex} brandColor={primary} onUse={setVoice} />)}
              <p className="text-[11px] text-[#94A3B8] sm:col-span-2 italic">Default voice — override per session.</p>
            </div>
          )}
        </Section>

        <Divider brandColor={primary} />

        {/* ═══ 05 STUDIO LOGO ═══ */}
        <Section num={5} dark brandColor={primary} kicker="Studio Logo" headline="Plant Your Flag.">
          <p className="text-[#4A4E5A] text-sm leading-relaxed mb-8 max-w-lg">Your logo gives FCA visual context.</p>
          <div className="flex flex-col sm:flex-row gap-6">
            <div className="flex-shrink-0 w-full sm:w-40 h-40 flex items-center justify-center overflow-hidden transition-all duration-300"
              style={{ background: logoUrl ? 'rgba(255,255,255,0.04)' : 'transparent', border: logoUrl ? `1px solid ${primary}30` : '1.5px dashed rgba(255,255,255,0.12)' }}>
              {logoUrl ? <img src={logoUrl} alt="Logo" className="max-w-full max-h-full object-contain p-3" /> :
                <div className="text-center"><ImagePlus size={24} className="mx-auto mb-2" style={{ color: 'rgba(255,255,255,0.15)' }} /><p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.15)' }}>NO LOGO</p></div>}
            </div>
            <div className="flex-1">
              <div className="h-40 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all duration-200"
                style={{ border: '1.5px dashed rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.02)' }}
                onClick={() => fileRef.current?.click()}>
                <Upload size={20} style={{ color: 'rgba(255,255,255,0.3)' }} />
                <p className="text-sm font-semibold" style={{ color: 'rgba(255,255,255,0.5)' }}>{logoUrl ? 'Replace Logo' : 'Upload Logo'}</p>
                <p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.2)' }}>PNG · SVG · JPG</p>
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={handleLogoUpload} />
            </div>
          </div>

          {/* ── Watermark logos (optional) ── */}
          <div className="mt-10 pt-8" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-[10px] font-semibold tracking-[0.18em] uppercase" style={{ color: primary }}>Watermark logos (optional)</span>
            </div>
            <p className="text-[#4A4E5A] text-sm leading-relaxed mb-6 max-w-lg">
              For stamping your logo onto generated images and reels. Upload a <em className="not-italic font-medium text-[#6A6E7A]">light</em> version for dark photos and a <em className="not-italic font-medium text-[#6A6E7A]">dark</em> version for light photos. FCA picks the right one automatically per image.
            </p>
            <div className="grid sm:grid-cols-2 gap-4">
              {/* Light variant — for dark backgrounds */}
              <div>
                <p className="text-[10px] font-bold tracking-[0.16em] uppercase mb-3" style={{ color: 'rgba(255,255,255,0.5)' }}>Light logo · for dark photos</p>
                <div className="h-32 flex items-center justify-center overflow-hidden cursor-pointer transition-all duration-200"
                  style={{ background: DARK, border: logoLightUrl ? `1px solid ${primary}30` : '1.5px dashed rgba(255,255,255,0.14)' }}
                  onClick={() => lightFileRef.current?.click()}>
                  {logoLightUrl ? <img src={logoLightUrl} alt="Light watermark" className="max-w-full max-h-full object-contain p-4" /> :
                    <div className="text-center"><ImagePlus size={20} className="mx-auto mb-2" style={{ color: 'rgba(255,255,255,0.18)' }} /><p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.18)' }}>UPLOAD LIGHT</p></div>}
                </div>
                {logoLightUrl && (
                  <button type="button" onClick={() => lightFileRef.current?.click()} className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: primary }}>
                    <Upload size={11} /> Replace
                  </button>
                )}
                <input ref={lightFileRef} type="file" accept="image/png,image/svg+xml,image/webp" className="hidden" onChange={e => handleVariantUpload(e, 'light')} />
              </div>
              {/* Dark variant — for light backgrounds */}
              <div>
                <p className="text-[10px] font-bold tracking-[0.16em] uppercase mb-3" style={{ color: 'rgba(255,255,255,0.5)' }}>Dark logo · for light photos</p>
                <div className="h-32 flex items-center justify-center overflow-hidden cursor-pointer transition-all duration-200"
                  style={{ background: LIGHT, border: logoDarkUrl ? `1px solid ${primary}30` : '1.5px dashed rgba(0,0,0,0.18)' }}
                  onClick={() => darkFileRef.current?.click()}>
                  {logoDarkUrl ? <img src={logoDarkUrl} alt="Dark watermark" className="max-w-full max-h-full object-contain p-4" /> :
                    <div className="text-center"><ImagePlus size={20} className="mx-auto mb-2" style={{ color: 'rgba(0,0,0,0.2)' }} /><p className="text-[11px]" style={{ color: 'rgba(0,0,0,0.25)' }}>UPLOAD DARK</p></div>}
                </div>
                {logoDarkUrl && (
                  <button type="button" onClick={() => darkFileRef.current?.click()} className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: primary }}>
                    <Upload size={11} /> Replace
                  </button>
                )}
                <input ref={darkFileRef} type="file" accept="image/png,image/svg+xml,image/webp" className="hidden" onChange={e => handleVariantUpload(e, 'dark')} />
              </div>
            </div>
            <p className="text-[11px] mt-4" style={{ color: 'rgba(255,255,255,0.25)' }}>Transparent PNG or SVG recommended.</p>
          </div>
        </Section>

        <Divider brandColor={primary} />

        {/* ═══ 06 PHOTO DIRECTION ═══ */}
        <Section num={6} dark={false} brandColor={primary} kicker="Photo Direction" headline="Where Your Images Come From.">
          <p className="text-[#475569] text-sm leading-relaxed mb-8 max-w-lg">Pick your image strategy.</p>
          <div className="grid sm:grid-cols-3 gap-px mb-8" style={{ background: 'rgba(0,0,0,0.08)' }}>
            {PHOTO_SOURCES.map(src => {
              const active = photoSrc === src.value
              return (
                <button key={src.value} type="button" onClick={() => handlePhotoSrc(src.value)}
                  className="relative p-6 text-left transition-all duration-200 group"
                  style={{ background: active ? primary : LIGHT, color: active ? (isLight(primary) ? DARK : '#fff') : DARK }}>
                  <src.Icon size={20} className="mb-4" style={{ opacity: active ? 1 : 0.4 }} />
                  <p className="font-black mb-1 leading-tight" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '1.1rem', letterSpacing: '0.06em' }}>{src.label}</p>
                  <p className="text-[11px] font-medium leading-relaxed" style={{ opacity: active ? 0.8 : 0.45 }}>{src.sub}</p>
                  {active && <Check size={13} className="absolute top-4 right-4" />}
                </button>
              )
            })}
          </div>
          {photoSrc !== 'studio_only' && (
            <div>
              <p className="text-[10px] font-bold tracking-[0.16em] uppercase mb-3" style={{ color: DARK }}>AI Photo Style Direction</p>
              <textarea value={prompt} onChange={e => handlePrompt(e.target.value)} rows={3}
                placeholder="e.g. Bright natural light, diverse women in their 30s–40s, mid-workout intensity, clean white studio background"
                className="w-full px-5 py-4 border-2 border-black/10 bg-white text-[#1e293b] text-sm leading-relaxed focus:outline-none transition-colors placeholder:text-[#CBD5E1] resize-y mb-4"
                onFocus={e => (e.target.style.borderColor = `${primary}80`)} onBlur={e => (e.target.style.borderColor = 'rgba(0,0,0,0.1)')} />
              <button type="button" onClick={() => setShowPhoto(v => !v)} className="flex items-center gap-2 text-[11px] font-bold tracking-[0.12em] uppercase mb-4 transition-colors" style={{ color: primary }}>
                <ChevronRight size={14} className="transition-transform duration-200" style={{ transform: showPhoto ? 'rotate(90deg)' : 'none' }} /> See examples by studio type
              </button>
              {showPhoto && (
                <div className="grid sm:grid-cols-2 gap-3">
                  {PHOTO_EXAMPLES.map(ex => <ExampleCard key={ex.studio} example={ex} brandColor={primary} onUse={handlePrompt} />)}
                </div>
              )}
            </div>
          )}
        </Section>

        {/* ═══ SAVE ═══ */}
        <div className="relative overflow-hidden px-6 sm:px-12 lg:px-16 py-14" style={{ background: saveState === 'saved' ? '#10B981' : primary }}>
          <span aria-hidden="true" className="absolute select-none pointer-events-none leading-none"
            style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 'clamp(120px, 22vw, 220px)', top: '-0.1em', right: '-0.05em', color: isLight(saveBtnBg) ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)' }}>
            {saveState === 'saved' ? 'DONE' : 'GO'}
          </span>
          <div className="relative z-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.2em] uppercase mb-2" style={{ color: isLight(saveBtnBg) ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.45)' }}>
                {saveState === 'saved' ? 'Brand saved' : 'Ready to commit'}
              </p>
              <h2 className="leading-none" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 'clamp(2rem, 5vw, 3.2rem)', letterSpacing: '0.02em', color: isLight(saveBtnBg) ? DARK : '#fff' }}>
                {saveState === 'saved' ? "FCA Knows Your Studio." : "Lock In Your Brand."}
              </h2>
            </div>
            <button type="button" onClick={handleSave} disabled={saveState === 'saving'}
              className="flex items-center gap-3 px-8 py-4 font-bold uppercase tracking-widest text-sm transition-all duration-300 disabled:opacity-60 hover:-translate-y-0.5 active:translate-y-0 flex-shrink-0"
              style={{ background: isLight(saveBtnBg) ? DARK : '#fff', color: isLight(saveBtnBg) ? '#fff' : (saveState === 'saved' ? '#10B981' : primary), fontFamily: "'DM Sans', sans-serif" }}>
              {saveState === 'saving' ? <><Loader2 size={16} className="animate-spin" /> Saving…</> :
                saveState === 'saved' ? <><Check size={16} /> Saved</> :
                  <>Save Brand Settings <ArrowRight size={16} /></>}
            </button>
          </div>
        </div>
      </div>
    </Layout>
  )
}

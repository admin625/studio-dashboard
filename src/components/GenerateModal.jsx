/**
 * GenerateModal — Content generation with session vibe, image slots, platform selection.
 * Fires to existing /.netlify/functions/generate-content endpoint.
 * Payload structure matches legacy exactly.
 */
import { useState, useRef, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import {
  X, Loader2, ChevronRight, Sparkles, Plus, Trash2,
} from 'lucide-react'

/* ── Platform modifier map ── */
const PLATFORM_MODIFIERS = {
  instagram: 'vertical 4:5 format, lifestyle aesthetic, vibrant colors, minimal text, editorial feel',
  facebook: 'horizontal 16:9 format, friendly and approachable, promotional clarity, warm tones',
  linkedin: 'professional tone, clean background, achievement-focused, polished lighting',
  tiktok: 'high energy, bold contrast, action-forward, dynamic composition, vertical format',
  all: '',
}

const PLATFORM_LABELS = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', all: 'All Platforms' }

const FREESTYLE_TEMPLATES = {
  event: 'Create posts promoting [event name] on [date]. Highlight what makes it special and include a sign-up CTA.',
  instructor: 'Feature [instructor name] and their [class type] classes. Show their personality and what students love about them.',
  transformation: 'Create posts around client transformation and results. Motivational tone, focus on the journey.',
  seasonal: 'Build a [season/holiday] campaign. Tie our classes to [seasonal theme] with a special offer.',
}

export default function GenerateModal({ open, onClose, onSubmitted }) {
  const app = useApp()
  const primary = app.brandColorPrimary || '#667eea'

  // Form state
  const [platforms, setPlatforms] = useState({
    instagram: { on: true, count: 3, images: true, formats: ['feed_post'] },
    facebook: { on: false, count: 3, images: true },
    twitter: { on: false, count: 3, images: false },
    linkedin: { on: false, count: 3, images: false },
    tiktok: { on: false, count: 3, images: false },
  })
  const [freestyle, setFreestyle] = useState(false)
  const [freestylePrompt, setFreestylePrompt] = useState('')
  const [sessionVibe, setSessionVibe] = useState(app.aiPhotoPrompt || app.brandVoice || '')
  const [brandVoice, setBrandVoice] = useState(app.brandVoice || 'Energetic, motivating, and community-focused')
  const [targetAudience, setTargetAudience] = useState('Fitness enthusiasts and local community members')
  const [fitnessFocus, setFitnessFocus] = useState('General fitness, wellness, and community')
  const [primaryGoal, setPrimaryGoal] = useState('')
  const [cta, setCta] = useState('Book a class today!')
  const [captionStyle, setCaptionStyle] = useState('engaging')
  const [hashtagPref, setHashtagPref] = useState('moderate')
  const [contentThemes, setContentThemes] = useState('')
  const [promotions, setPromotions] = useState('')

  // Image slots
  const [imageSlots, setImageSlots] = useState([{ id: 1, platforms: ['all'], direction: '' }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const addSlot = () => {
    if (imageSlots.length >= 3) return
    setImageSlots(s => [...s, { id: Date.now(), platforms: ['all'], direction: '' }])
  }

  const removeSlot = (idx) => {
    if (imageSlots.length <= 1) return
    setImageSlots(s => s.filter((_, i) => i !== idx))
  }

  const toggleSlotPlatform = (idx, platform) => {
    setImageSlots(s => s.map((slot, i) => {
      if (i !== idx) return slot
      if (platform === 'all') return { ...slot, platforms: ['all'] }
      let ps = slot.platforms.filter(p => p !== 'all')
      if (ps.includes(platform)) ps = ps.filter(p => p !== platform)
      else ps.push(platform)
      if (ps.length === 0) ps = ['all']
      return { ...slot, platforms: ps }
    }))
  }

  const updateSlotDirection = (idx, val) => {
    setImageSlots(s => s.map((slot, i) => i === idx ? { ...slot, direction: val } : slot))
  }

  const togglePlatform = (name) => {
    setPlatforms(p => ({ ...p, [name]: { ...p[name], on: !p[name].on } }))
  }

  const getImageSlotsPayload = () => {
    return imageSlots
      .filter(s => s.direction.trim())
      .flatMap(s => s.platforms.map(p => {
        const mod = PLATFORM_MODIFIERS[p] || ''
        const parts = []
        if (sessionVibe.trim()) parts.push(sessionVibe.trim())
        parts.push(s.direction.trim())
        if (mod) parts.push('Style: ' + mod)
        return { platform: p, direction: parts.join('. '), direction_raw: s.direction.trim(), session_vibe: sessionVibe.trim() }
      }))
  }

  const handleSubmit = async () => {
    const activePlatforms = Object.entries(platforms)
      .filter(([_, v]) => v.on)
      .map(([name, v]) => {
        const plat = { name, postCount: v.count, includeImages: v.images }
        if (name === 'instagram') plat.formats = v.formats || ['feed_post']
        return plat
      })

    if (!activePlatforms.length) {
      setError('Please select at least one platform.')
      return
    }
    if (freestyle && !freestylePrompt.trim()) {
      setError('Please describe what content you want to create.')
      return
    }

    setSubmitting(true)
    setError('')

    const slotsPayload = getImageSlotsPayload()
    const legacyPrompt = imageSlots.map(s => s.direction).filter(Boolean).join('; ')

    const payload = {
      email: app.email,
      studio_id: app.resolvedStudioId,
      client_id: app.resolvedClientId,
      user_role: app.role,
      platforms: activePlatforms,
      client_type: 'fitness_studio',
      photo_source: app.photoSource,
      ai_photo_prompt: legacyPrompt || app.aiPhotoPrompt || '',
      session_vibe: sessionVibe,
      image_slots: slotsPayload,
      studio_name: app.studioName || '',
      studio_type: app.studioType || '',
      brand_color: app.brandColorPrimary || '',
      last_content_types: app.lastContentTypes || [],
    }

    if (freestyle) {
      Object.assign(payload, {
        freestyle: true,
        freestyle_prompt: freestylePrompt.trim(),
        brand_voice: brandVoice,
        target_audience: 'Fitness enthusiasts',
        fitness_focus: 'General fitness',
        primary_goal: 'Grow community engagement and class bookings',
        cta: 'Book a class today!',
        caption_style: 'engaging',
        hashtag_preference: 'moderate',
        content_themes: [],
      })
    } else {
      Object.assign(payload, {
        brand_voice: brandVoice,
        target_audience: targetAudience,
        fitness_focus: fitnessFocus,
        primary_goal: primaryGoal,
        cta,
        caption_style: captionStyle,
        hashtag_preference: hashtagPref,
        content_themes: contentThemes ? contentThemes.split(',').map(t => t.trim()).filter(Boolean) : [],
        promotions,
      })
    }

    // Fire and forget — don't wait for n8n
    fetch('/.netlify/functions/generate-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => {
      if (!r.ok) console.warn('[Generate] Server responded with', r.status)
    }).catch(err => {
      console.warn('[Generate] Request error:', err.message)
    })

    onClose()
    if (onSubmitted) onSubmitted(activePlatforms.map(p => p.name))
    setSubmitting(false)
  }

  if (!open) return null

  const isOwner = app.role === 'studio_owner'
  const showImageBuilder = isOwner && app.photoSource !== 'studio_only'

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto py-10 px-4" style={{ background: 'rgba(0,0,0,0.8)' }}>
      <div
        className="w-full max-w-2xl rounded-2xl overflow-hidden"
        style={{ background: '#0A0B0D', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div>
            <h2 className="text-white text-lg font-bold" style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: '0.03em' }}>
              Generate New Content
            </h2>
            <p className="text-slate-200 text-xs">FCA creates content suggestions — you decide what goes live.</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors p-1"><X size={20} /></button>
        </div>

        <div className="px-6 py-5 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* Session Vibe */}
          <div className="p-4 rounded-xl" style={{ background: `${primary}10`, border: `1px solid ${primary}30` }}>
            <label className="block text-xs font-bold tracking-wider uppercase mb-1" style={{ color: primary }}>This session's vibe</label>
            <p className="text-[11px] text-slate-400 mb-2">Adjust for this batch only — won't affect your saved settings.</p>
            <textarea
              value={sessionVibe}
              onChange={e => setSessionVibe(e.target.value)}
              rows={2}
              placeholder="e.g. Valentine's week — warm, fun, couples energy, soft pinks and reds"
              className="w-full px-3 py-2.5 rounded-lg text-sm text-white placeholder-slate-600 resize-y focus:outline-none"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
            />
          </div>

          {/* Freestyle toggle */}
          {isOwner && (
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={freestyle} onChange={e => setFreestyle(e.target.checked)} className="sr-only peer" />
              <div className="w-10 h-5 bg-slate-700 rounded-full peer-checked:bg-indigo-500 transition-colors relative">
                <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5" style={{ transform: freestyle ? 'translateX(20px)' : 'none' }} />
              </div>
              <span className="text-sm text-slate-300 font-medium">Freestyle Mode</span>
            </label>
          )}

          {freestyle ? (
            <div>
              <textarea
                value={freestylePrompt}
                onChange={e => setFreestylePrompt(e.target.value)}
                rows={4}
                placeholder="Tell me what you want. For example: Create 3 Instagram posts about our new summer bootcamp..."
                className="w-full px-4 py-3 rounded-xl text-sm text-white placeholder-slate-600 resize-y focus:outline-none"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
              />
              <div className="flex flex-wrap gap-2 mt-3">
                {Object.entries(FREESTYLE_TEMPLATES).map(([key, text]) => (
                  <button key={key} type="button" onClick={() => setFreestylePrompt(text)}
                    className="px-3 py-1.5 rounded-lg text-[10px] font-semibold uppercase tracking-wider text-slate-400 hover:text-white transition-colors"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    {key}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Platform selector */}
              <div>
                <label className="block text-xs font-bold tracking-wider uppercase text-slate-400 mb-2">Platforms</label>
                <div className="space-y-2">
                  {Object.entries(platforms).map(([name, cfg]) => (
                    <div key={name} className="flex items-center gap-3 p-3 rounded-lg" style={{ background: cfg.on ? 'rgba(255,255,255,0.04)' : 'transparent', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <label className="flex items-center gap-2 cursor-pointer flex-1">
                        <input type="checkbox" checked={cfg.on} onChange={() => togglePlatform(name)} className="accent-indigo-500" />
                        <span className="text-sm text-slate-300 font-medium capitalize">{name === 'twitter' ? 'X (Twitter)' : name}</span>
                      </label>
                      {cfg.on && (
                        <div className="flex items-center gap-3">
                          {/* Image toggle */}
                          <button
                            type="button"
                            onClick={() => setPlatforms(p => ({ ...p, [name]: { ...p[name], images: !p[name].images } }))}
                            className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-wider transition-all"
                            style={{
                              background: cfg.images ? `${primary}20` : 'rgba(255,255,255,0.04)',
                              color: cfg.images ? primary : '#64748b',
                              border: `1px solid ${cfg.images ? primary + '40' : 'rgba(255,255,255,0.08)'}`,
                            }}
                            title={cfg.images ? 'Images ON — click to disable' : 'Images OFF — click to enable'}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                            {cfg.images ? 'IMG' : 'NO IMG'}
                          </button>
                          {/* Post count */}
                          <select
                            value={cfg.count}
                            onChange={e => setPlatforms(p => ({ ...p, [name]: { ...p[name], count: parseInt(e.target.value) } }))}
                            className="px-2 py-1 rounded text-xs text-white bg-white/5 border border-white/10"
                          >
                            {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} posts</option>)}
                          </select>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Reels (disabled — coming soon) */}
                  <div
                    className="flex items-center gap-3 p-3 rounded-lg opacity-60 cursor-not-allowed"
                    style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.04)' }}
                    title="Video reels are coming soon — we'll notify you when they're ready."
                  >
                    <label className="flex items-center gap-2 flex-1 cursor-not-allowed">
                      <input
                        type="checkbox"
                        disabled
                        checked={false}
                        readOnly
                        className="accent-indigo-500 cursor-not-allowed"
                      />
                      <span className="text-sm text-slate-500 font-medium">Reels</span>
                      <span
                        className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
                        style={{ background: '#2A2A2A', color: '#A0A0A0' }}
                      >
                        Coming Soon
                      </span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Standard fields */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Brand Voice" value={brandVoice} onChange={setBrandVoice} />
                <Field label="Target Audience" value={targetAudience} onChange={setTargetAudience} />
                <Field label="Fitness Focus" value={fitnessFocus} onChange={setFitnessFocus} />
                <Field label="Primary Goal" value={primaryGoal} onChange={setPrimaryGoal} />
                <Field label="CTA" value={cta} onChange={setCta} />
                <Field label="Caption Style" value={captionStyle} onChange={setCaptionStyle} />
              </div>
            </div>
          )}

          {/* Image Slot Builder (owner + AI modes) */}
          {showImageBuilder && (
            <div>
              <label className="block text-xs font-bold tracking-wider uppercase text-slate-400 mb-2">AI Image Direction</label>
              <div className="space-y-2">
                {imageSlots.map((slot, idx) => (
                  <div key={slot.id} className="p-3 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Image {idx + 1}</span>
                      {imageSlots.length > 1 && (
                        <button onClick={() => removeSlot(idx)} className="text-slate-500 hover:text-red-400 transition-colors"><Trash2 size={14} /></button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {Object.entries(PLATFORM_LABELS).map(([key, label]) => (
                        <button key={key} type="button" onClick={() => toggleSlotPlatform(idx, key)}
                          className="px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all"
                          style={{
                            background: slot.platforms.includes(key) ? `${primary}20` : 'rgba(255,255,255,0.04)',
                            color: slot.platforms.includes(key) ? primary : '#64748b',
                            border: `1px solid ${slot.platforms.includes(key) ? primary + '60' : 'rgba(255,255,255,0.08)'}`,
                          }}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <textarea
                      value={slot.direction}
                      onChange={e => updateSlotDirection(idx, e.target.value)}
                      rows={2}
                      placeholder="Describe this image..."
                      className="w-full px-3 py-2 rounded-lg text-sm text-white placeholder-slate-600 resize-y focus:outline-none"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                    />
                  </div>
                ))}
              </div>
              {imageSlots.length < 3 && (
                <button onClick={addSlot}
                  className="w-full mt-2 py-2.5 rounded-lg text-xs font-semibold text-slate-500 hover:text-white transition-all flex items-center justify-center gap-2"
                  style={{ border: '1.5px dashed rgba(255,255,255,0.08)' }}>
                  <Plus size={14} /> Add Image
                </button>
              )}
              <p className="text-[10px] text-slate-500 mt-2 text-center">Each AI image adds ~1 minute to generation time</p>
            </div>
          )}

          {error && (
            <div className="px-4 py-3 rounded-lg text-sm text-red-300" style={{ background: 'rgba(239,68,68,0.1)' }}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center justify-between">
            <button onClick={onClose} className="text-sm text-slate-500 hover:text-white transition-colors">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-all hover:-translate-y-0.5 disabled:opacity-60"
              style={{ background: primary, color: isLight(primary) ? '#0A0B0D' : '#fff' }}
            >
              {submitting ? <><Loader2 size={16} className="animate-spin" /> Creating...</> : <><Sparkles size={16} /> Create Content</>}
            </button>
          </div>
          <p className="text-[10px] text-slate-500 text-center mt-3">
            FCA generates premium content — great things take a moment. Ready within 20 minutes.
          </p>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold tracking-wider uppercase text-slate-400 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
      />
    </div>
  )
}

function isLight(hex = '#000') {
  hex = hex.replace('#', '')
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2]
  if (hex.length !== 6) return false
  const r = parseInt(hex.substr(0,2),16), g = parseInt(hex.substr(2,2),16), b = parseInt(hex.substr(4,2),16)
  return (r*299 + g*587 + b*114)/1000 > 155
}

/**
 * PostCard — Single post within a delivery detail.
 * Caption, hashtags, photo, metadata, edit/copy/download actions, inline photo editor.
 */
import { useState, useRef, useEffect } from 'react'
import { supabase, SUPABASE_URL } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import {
  Copy, Check, Pencil, Download, Clock, Target,
  Image as ImageIcon, Sparkles, Save, X, Loader2, ChevronDown, ChevronUp, Edit3, Wand2,
} from 'lucide-react'

const PLATFORM_LABEL = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', all: 'All Platforms' }
const FORMAT_COLORS = {
  feed_post: { bg: '#dcfce7', color: '#166534' },
  story: { bg: '#fef3c7', color: '#92400e' },
  thread: { bg: '#f3e8ff', color: '#6b21a8' },
  carousel: { bg: '#fce7f3', color: '#9d174d' },
}

const PROMPT_PLACEHOLDER = 'Describe the photo you want...'

export default function PostCard({ post, index, platform, deliveryId, readOnly }) {
  const { brandColorPrimary, resolvedStudioId, email, studioName, studioType, brandVoice, aiPhotoPrompt } = useApp()
  const primary = brandColorPrimary || '#667eea'

  const [editing, setEditing] = useState(null) // 'caption' | 'hashtags' | null
  const [captionText, setCaptionText] = useState(post.caption || '')
  const [hashtagText, setHashtagText] = useState(post.hashtags || '')
  const [copied, setCopied] = useState(null) // 'caption' | 'hashtags' | null
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef(null)

  // Photo editor state
  const [editorOpen, setEditorOpen] = useState(false)
  const initialPrompt =
    post.image_prompt ||
    post.generation_prompt ||
    post.image_direction ||
    post.photo_keywords ||
    ''
  const [promptText, setPromptText] = useState(initialPrompt || PROMPT_PLACEHOLDER)
  const [regenerating, setRegenerating] = useState(false)
  const [savingToLib, setSavingToLib] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [studioPhotos, setStudioPhotos] = useState([])
  const [loadingPhotos, setLoadingPhotos] = useState(false)
  const [overridePhotoUrl, setOverridePhotoUrl] = useState(null)
  const [overrideIsAI, setOverrideIsAI] = useState(null)
  // undefined = no override yet (use post values); null/string = explicit override after regenerate or pick
  const [overridePrompt, setOverridePrompt] = useState(undefined)
  const [editorMsg, setEditorMsg] = useState(null)
  const [promptExpanded, setPromptExpanded] = useState(false)

  // AI generate from picker — async flow separate from sync handleRegenerate in editor
  const [aiGenOpen, setAiGenOpen] = useState(false)
  const [aiGenPrompt, setAiGenPrompt] = useState('')
  const [aiGenerating, setAiGenerating] = useState(false)
  const [aiGenStartedAt, setAiGenStartedAt] = useState(0)
  const [aiGenTimedOut, setAiGenTimedOut] = useState(false)
  const [sessionAiPhotos, setSessionAiPhotos] = useState([])

  // Poll the studio-photos bucket for AI-generated files landing after our trigger.
  // Bypasses the studio_photos table (Bug C — anon INSERT blocked by RLS) by reading
  // storage.objects directly, which has a permissive SELECT policy for this bucket.
  // 30-min deadline: stop polling but leave the banner showing a graceful fallback.
  useEffect(() => {
    if (!aiGenerating || !resolvedStudioId) return
    const POLL_MS = 10_000
    const DEADLINE_MS = 30 * 60 * 1000
    const deadline = aiGenStartedAt + DEADLINE_MS
    const id = setInterval(async () => {
      if (Date.now() > deadline) {
        setAiGenTimedOut(true)
        clearInterval(id)
        return
      }
      try {
        const { data } = await supabase.storage
          .from('studio-photos')
          .list(`ai-generated/${resolvedStudioId}/`, {
            limit: 10,
            sortBy: { column: 'created_at', order: 'desc' },
          })
        if (!data || data.length === 0) return
        const fresh = data.filter(f => new Date(f.created_at).getTime() > aiGenStartedAt)
        if (fresh.length === 0) return
        const toAdd = fresh.map(f => ({
          photo_url: `${SUPABASE_URL}/storage/v1/object/public/studio-photos/ai-generated/${resolvedStudioId}/${f.name}`,
          file_name: f.name,
          generation_prompt: aiGenPrompt,
          source: 'ai_generated',
          created_at: f.created_at,
        }))
        setSessionAiPhotos(prev => {
          const existing = new Set(prev.map(p => p.file_name))
          const novel = toAdd.filter(p => !existing.has(p.file_name))
          return novel.length > 0 ? [...novel, ...prev] : prev
        })
        setAiGenerating(false)
        clearInterval(id)
      } catch (e) {
        // Silent — next tick retries. A stalled poll isn't recoverable here anyway.
      }
    }, POLL_MS)
    return () => clearInterval(id)
  }, [aiGenerating, aiGenStartedAt, resolvedStudioId, aiGenPrompt])

  const currentPhotoUrl = overridePhotoUrl || post.photo_url
  const baseIsAI = post.needs_ai_image || (!post.matched_photo_id && post.photo_url)
  const isAI = overrideIsAI !== null ? overrideIsAI : baseIsAI
  const hasImage = currentPhotoUrl || post.needs_ai_image
  const fmtStyle = FORMAT_COLORS[post.format] || null

  // Effective prompt that generated the currently displayed photo.
  // Prefers the in-session override (set on regenerate/pick) over the persisted post value.
  const effectivePrompt =
    overridePrompt !== undefined
      ? overridePrompt
      : (post.image_prompt || post.generation_prompt || post.photo_keywords || null)

  const flashMsg = (msg) => {
    setEditorMsg(msg)
    setTimeout(() => setEditorMsg(null), 4000)
  }

  const handleCopy = async (type) => {
    const text = type === 'caption' ? captionText : hashtagText
    try {
      await navigator.clipboard.writeText(text)
      setCopied(type)
      setTimeout(() => setCopied(null), 2000)
    } catch (e) {
      console.warn('Copy failed:', e)
    }
  }

  const handleSave = async (field) => {
    setSaving(true)
    try {
      const { data } = await supabase
        .from('content_deliveries')
        .select(`${platform}_content`)
        .eq('id', deliveryId)
        .single()

      if (data) {
        const content = data[`${platform}_content`] || []
        if (content[index]) {
          content[index][field] = field === 'caption' ? captionText : hashtagText
          await supabase
            .from('content_deliveries')
            .update({ [`${platform}_content`]: content })
            .eq('id', deliveryId)
        }
      }
    } catch (e) {
      console.error('[PostCard] Save failed:', e)
    }
    setSaving(false)
    setEditing(null)
  }

  // Persist photo changes back to the content_deliveries JSONB
  const persistPhotoChange = async (newUrl, extraFields = {}) => {
    try {
      const { data } = await supabase
        .from('content_deliveries')
        .select(`${platform}_content`)
        .eq('id', deliveryId)
        .single()
      if (!data) return
      const content = data[`${platform}_content`] || []
      if (!content[index]) return
      content[index].photo_url = newUrl
      Object.assign(content[index], extraFields)
      await supabase
        .from('content_deliveries')
        .update({ [`${platform}_content`]: content })
        .eq('id', deliveryId)
    } catch (e) {
      console.error('[PostCard] Photo persist failed:', e)
    }
  }

  // Load studio photos for the picker (lazy, only on open)
  const loadStudioPhotos = async () => {
    if (!resolvedStudioId) return
    setLoadingPhotos(true)
    try {
      const { data } = await supabase
        .from('studio_photos')
        .select('id, photo_url, thumbnail_url, keywords, source, tags, file_name')
        .eq('studio_id', resolvedStudioId)
        .eq('is_active', true)
        .order('upload_date', { ascending: false })
        .limit(60)
      if (data) setStudioPhotos(data)
    } catch (e) {
      flashMsg({ type: 'error', text: 'Could not load photo library' })
    }
    setLoadingPhotos(false)
  }

  const togglePicker = async () => {
    if (!pickerOpen && studioPhotos.length === 0) {
      await loadStudioPhotos()
    }
    setPickerOpen(v => !v)
  }

  const handleRegenerate = async () => {
    const prompt = (promptText || '').trim()
    if (!prompt || prompt === PROMPT_PLACEHOLDER || !resolvedStudioId) {
      flashMsg({ type: 'error', text: 'Write a real prompt first' })
      return
    }
    setRegenerating(true)
    setEditorMsg(null)
    try {
      const res = await fetch('/.netlify/functions/proxy-webhook?target=ai-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'nano_banana_pro',
          prompt,
          width: 1024,
          height: 1024,
          studio_id: resolvedStudioId,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.image_url) {
        throw new Error(data.error || data.detail || 'Image generation failed')
      }
      const newUrl = data.image_url
      setOverridePhotoUrl(newUrl)
      setOverrideIsAI(true)
      setOverridePrompt(prompt)
      await persistPhotoChange(newUrl, {
        image_prompt: prompt,
        generation_prompt: prompt,
        matched_photo_id: null,
        needs_ai_image: false,
      })
      flashMsg({ type: 'success', text: 'Image regenerated' })
    } catch (e) {
      flashMsg({ type: 'error', text: e.message || 'Regenerate failed' })
    }
    setRegenerating(false)
  }

  const handlePickPhoto = async (photo) => {
    setOverridePhotoUrl(photo.photo_url)
    setOverrideIsAI(photo.source === 'ai_generated')
    setOverridePrompt(photo.generation_prompt || null)
    try {
      await persistPhotoChange(photo.photo_url, {
        matched_photo_id: photo.id,
        needs_ai_image: false,
      })
      flashMsg({ type: 'success', text: 'Photo replaced' })
      setPickerOpen(false)
    } catch (e) {
      flashMsg({ type: 'error', text: 'Could not replace photo' })
    }
  }

  // Compose a prompt from the post + the studio's brand context. Editable before firing.
  const buildAiPrompt = () => {
    const postExcerpt = (post.caption || '').trim().slice(0, 200)
    const parts = []
    parts.push(`${studioName || 'Fitness studio'} — photo for this post.`)
    if (postExcerpt) parts.push(`Post: "${postExcerpt}"`)
    const aesthetic = []
    if (studioType) aesthetic.push(`${studioType} studio`)
    if (primary) aesthetic.push(`brand color ${primary}`)
    if (brandVoice) aesthetic.push(`voice ${brandVoice}`)
    if (aesthetic.length) parts.push(`Studio aesthetic: ${aesthetic.join(', ')}.`)
    if (aiPhotoPrompt) parts.push(aiPhotoPrompt.trim())
    return parts.join('\n\n')
  }

  const openAiGen = () => {
    setAiGenPrompt(buildAiPrompt())
    setAiGenOpen(true)
  }

  const startAiGeneration = () => {
    const prompt = (aiGenPrompt || '').trim()
    if (!prompt || !resolvedStudioId) {
      flashMsg({ type: 'error', text: 'Prompt required' })
      return
    }
    setAiGenStartedAt(Date.now())
    setAiGenTimedOut(false)
    setAiGenOpen(false)
    setAiGenerating(true)
    // Fire and forget — the async flow polls the bucket for completion. The Netlify proxy's
    // 26s function-timeout is longer than we need here since we're not awaiting the response.
    fetch('/.netlify/functions/proxy-webhook?target=ai-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studio_id: resolvedStudioId,
        platform: 'nano_banana_pro',
        prompt,
        width: 1024,
        height: 1024,
        content_focus: (post.caption || '').slice(0, 120),
        _source: 'post_picker_generate_button',
      }),
    }).catch(err => {
      console.warn('[AI Gen] fire-and-forget error:', err.message)
    })
  }

  const dismissAiBanner = () => {
    setAiGenerating(false)
    setAiGenTimedOut(false)
  }

  const handleSaveToLibrary = async () => {
    if (!currentPhotoUrl || !resolvedStudioId) return
    setSavingToLib(true)
    try {
      const { error } = await supabase.from('studio_photos').insert({
        studio_id: resolvedStudioId,
        photo_url: currentPhotoUrl,
        keywords: 'ai_generated',
        source: 'ai_generated',
        generation_model: 'nano_banana_pro',
        generation_prompt: promptText !== PROMPT_PLACEHOLDER ? promptText : null,
        uploaded_by: email || null,
        is_active: true,
        tags: null,
      })
      if (error) throw error
      flashMsg({ type: 'success', text: 'Saved to photo library' })
    } catch (e) {
      flashMsg({ type: 'error', text: 'Save failed: ' + e.message })
    }
    setSavingToLib(false)
  }

  return (
    <div
      className="rounded-xl overflow-hidden mb-4"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <span className="text-xs font-bold text-slate-400">Post #{post.post_number || index + 1}</span>
        {post.content_type && (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider" style={{ background: `${primary}20`, color: primary }}>
            {post.content_type}
          </span>
        )}
        {post.format && fmtStyle && (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider" style={{ background: fmtStyle.bg, color: fmtStyle.color }}>
            {post.format.replace('_', ' ')}
          </span>
        )}
      </div>

      {/* Image */}
      {hasImage && currentPhotoUrl && (
        <div className="relative">
          {post.image_platform && (
            <span
              className="absolute top-3 left-3 z-10 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
              style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', backdropFilter: 'blur(4px)' }}
            >
              {PLATFORM_LABEL[post.image_platform] || post.image_platform}
            </span>
          )}
          <img src={currentPhotoUrl} alt="Post" className="w-full max-h-96 object-cover" />
          <div className="flex items-center gap-2 px-5 py-2" style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: isAI ? '#a78bfa' : '#10b981' }}>
              {isAI ? 'AI Generated' : 'Studio Photo'}
            </span>
            {post.image_direction && (
              <span className="text-[10px] text-slate-500 italic truncate">{post.image_direction}</span>
            )}
          </div>

          {/* Image prompt subtext — AI-generated photos ONLY, not studio library photos.
              Click the row to open the photo editor pre-filled. Truncates at 120 chars
              with a "show more" toggle. Helper line below points to the edit flow. */}
          {isAI && effectivePrompt && (() => {
            const PROMPT_LIMIT = 120
            const isLong = effectivePrompt.length > PROMPT_LIMIT
            const shown = promptExpanded || !isLong
              ? effectivePrompt
              : effectivePrompt.slice(0, PROMPT_LIMIT).trimEnd() + '…'
            return (
              <div
                style={{
                  background: 'rgba(255,255,255,0.01)',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                }}
              >
                <button
                  type="button"
                  onClick={() => { if (!editorOpen && !readOnly) setEditorOpen(true) }}
                  title={effectivePrompt}
                  className="w-full flex items-start gap-2 px-5 pt-3 pb-1 text-left transition-colors hover:bg-white/[0.025]"
                  style={{ cursor: editorOpen || readOnly ? 'default' : 'pointer' }}
                >
                  <Edit3 size={13} className="flex-shrink-0 mt-[2px]" style={{ color: '#A0A0A0' }} />
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold mr-1.5" style={{ color: '#A0A0A0', fontSize: '13px' }}>
                      Image prompt:
                    </span>
                    <span style={{ color: '#A0A0A0', fontSize: '13px' }}>
                      {shown}
                    </span>
                    {isLong && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPromptExpanded(v => !v)
                        }}
                        className="ml-1.5 font-semibold transition-colors"
                        style={{ color: primary, fontSize: '13px' }}
                      >
                        {promptExpanded ? 'show less' : 'show more'}
                      </button>
                    )}
                  </div>
                </button>
                <p
                  className="px-5 pb-2 italic"
                  style={{ color: '#666666', fontSize: '11px', paddingLeft: '39px' }}
                >
                  Adjust this prompt in Edit Photo to regenerate with changes.
                </p>
              </div>
            )
          })()}

          {/* Edit Photo toggle */}
          {!readOnly && (
            <div className="px-5 py-2" style={{ background: 'rgba(255,255,255,0.02)', borderBottom: editorOpen ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
              <button
                onClick={() => setEditorOpen(v => !v)}
                className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors"
                style={{ color: editorOpen ? primary : '#64748b' }}
              >
                <Pencil size={11} />
                {editorOpen ? 'Close photo editor' : 'Edit Photo'}
                {editorOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </button>
            </div>
          )}

          {/* Inline editor panel */}
          {!readOnly && editorOpen && (
            <div className="px-5 py-4" style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              {/* Prompt */}
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                Photo Prompt
              </label>
              <textarea
                value={promptText}
                onChange={e => setPromptText(e.target.value)}
                onFocus={e => { if (promptText === PROMPT_PLACEHOLDER) setPromptText('') }}
                onBlur={e => { if (!promptText.trim()) setPromptText(initialPrompt || PROMPT_PLACEHOLDER) }}
                rows={3}
                placeholder={PROMPT_PLACEHOLDER}
                className="w-full px-3 py-2.5 rounded-lg text-sm text-white resize-y focus:outline-none mb-3"
                style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${primary}40` }}
              />

              {/* Action buttons */}
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleRegenerate}
                  disabled={regenerating}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                  style={{ background: primary, color: '#fff' }}
                >
                  {regenerating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                  {regenerating ? 'Regenerating...' : 'Regenerate'}
                </button>

                <button
                  onClick={togglePicker}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all hover:-translate-y-0.5"
                  style={{ background: 'rgba(255,255,255,0.06)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <ImageIcon size={12} />
                  {pickerOpen ? 'Hide library' : 'Choose from Studio Photos'}
                </button>

                <button
                  onClick={handleSaveToLibrary}
                  disabled={savingToLib || !currentPhotoUrl}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all hover:-translate-y-0.5 disabled:opacity-60"
                  style={{ background: 'rgba(255,255,255,0.06)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  {savingToLib ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  {savingToLib ? 'Saving...' : 'Save to Library'}
                </button>
              </div>

              {/* Status message */}
              {editorMsg && (
                <div
                  className="mt-3 px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2"
                  style={{
                    background: editorMsg.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                    color: editorMsg.type === 'success' ? '#10b981' : '#ef4444',
                    border: `1px solid ${editorMsg.type === 'success' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
                  }}
                >
                  {editorMsg.type === 'success' ? <Check size={12} /> : <X size={12} />}
                  {editorMsg.text}
                </div>
              )}

              {/* Studio photo picker */}
              {pickerOpen && (
                <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Studio Photo Library {!loadingPhotos && studioPhotos.length > 0 && `(${studioPhotos.length})`}
                    </span>
                    <button onClick={() => setPickerOpen(false)} className="text-slate-500 hover:text-white transition-colors">
                      <X size={14} />
                    </button>
                  </div>

                  {/* ── AI generate: primary CTA (initial state) ── */}
                  {!aiGenOpen && !aiGenerating && (
                    <button
                      onClick={openAiGen}
                      disabled={!resolvedStudioId}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-xs font-bold uppercase tracking-wider transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed mb-3"
                      style={{ background: primary, color: '#fff' }}
                    >
                      <Wand2 size={14} /> Generate AI Image
                    </button>
                  )}

                  {/* ── AI generate: confirmation panel (prompt edit before firing) ── */}
                  {aiGenOpen && (
                    <div className="mb-3 p-3 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${primary}30` }}>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                        Describe the photo you want
                      </label>
                      <textarea
                        value={aiGenPrompt}
                        onChange={e => setAiGenPrompt(e.target.value)}
                        rows={4}
                        className="w-full px-3 py-2.5 rounded-lg text-sm text-white placeholder-slate-600 resize-y focus:outline-none mb-3"
                        style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${primary}40` }}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={startAiGeneration}
                          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all hover:-translate-y-0.5"
                          style={{ background: primary, color: '#fff' }}
                        >
                          <Sparkles size={12} /> Generate
                        </button>
                        <button
                          onClick={() => setAiGenOpen(false)}
                          className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition-all"
                          style={{ background: 'rgba(255,255,255,0.06)' }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ── AI generate: in-flight banner ── */}
                  {aiGenerating && (
                    <div
                      className="mb-3 flex items-start gap-3 px-4 py-3 rounded-lg"
                      style={{ background: `${primary}12`, border: `1px solid ${primary}30` }}
                    >
                      <Sparkles size={16} className="flex-shrink-0 mt-0.5 animate-pulse" style={{ color: primary }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white font-semibold">
                          {aiGenTimedOut ? 'Taking longer than usual' : 'Your AI image is generating'}
                        </p>
                        <p className="text-xs text-slate-300 mt-0.5">
                          {aiGenTimedOut
                            ? 'Image will appear in your Photos page when ready.'
                            : "Ready in about 1 minute. Keep working — it'll land here when done."}
                        </p>
                      </div>
                      <button onClick={dismissAiBanner} className="flex-shrink-0 text-slate-400 hover:text-white transition-colors" aria-label="Dismiss">
                        <X size={14} />
                      </button>
                    </div>
                  )}

                  {/* ── Just generated (session) ── */}
                  {sessionAiPhotos.length > 0 && (
                    <div className="mb-4">
                      <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: primary }}>
                        Just generated ({sessionAiPhotos.length})
                      </p>
                      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2">
                        {sessionAiPhotos.map(photo => {
                          const isCurrent = photo.photo_url === currentPhotoUrl
                          return (
                            <button
                              key={photo.file_name}
                              onClick={() => handlePickPhoto(photo)}
                              className="aspect-square rounded-lg overflow-hidden relative transition-all hover:-translate-y-0.5"
                              style={{
                                border: isCurrent ? `2px solid ${primary}` : `1.5px solid ${primary}40`,
                                opacity: isCurrent ? 0.65 : 1,
                              }}
                            >
                              <img src={photo.photo_url} alt="Just generated" className="w-full h-full object-cover" loading="lazy" />
                              <span
                                className="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider"
                                style={{ background: 'rgba(0,0,0,0.7)', color: '#fff', backdropFilter: 'blur(4px)' }}
                              >
                                AI
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {loadingPhotos ? (
                    <div className="py-8 text-center">
                      <Loader2 size={20} className="animate-spin mx-auto" style={{ color: primary }} />
                    </div>
                  ) : studioPhotos.length === 0 ? (
                    <p className="text-xs text-slate-400 py-4 text-center">No photos in your library yet.</p>
                  ) : (
                    <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2 max-h-72 overflow-y-auto">
                      {studioPhotos.map(photo => {
                        const isCurrent = photo.photo_url === currentPhotoUrl
                        const photoIsAI = photo.source === 'ai_generated'
                        return (
                          <button
                            key={photo.id}
                            onClick={() => handlePickPhoto(photo)}
                            className="relative aspect-square rounded-lg overflow-hidden group transition-all hover:-translate-y-0.5"
                            style={{
                              border: isCurrent ? `2px solid ${primary}` : '1px solid rgba(255,255,255,0.06)',
                              boxShadow: isCurrent ? `0 0 0 2px ${primary}30` : 'none',
                            }}
                          >
                            <img
                              src={photo.thumbnail_url || photo.photo_url}
                              alt={photo.keywords || 'Studio photo'}
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                            <span
                              className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider"
                              style={{
                                background: photoIsAI ? 'rgba(139,92,246,0.3)' : 'rgba(16,185,129,0.3)',
                                color: photoIsAI ? '#c4b5fd' : '#6ee7b7',
                                backdropFilter: 'blur(4px)',
                              }}
                            >
                              {photoIsAI ? 'AI' : 'Studio'}
                            </span>
                            {isCurrent && (
                              <span
                                className="absolute bottom-1 right-1 w-4 h-4 rounded-full flex items-center justify-center"
                                style={{ background: primary }}
                              >
                                <Check size={10} className="text-white" />
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Metadata */}
      {(post.optimal_posting_time || post.engagement_goal) && (
        <div className="px-5 py-3 flex flex-wrap gap-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          {post.optimal_posting_time && (
            <div className="flex items-center gap-2">
              <Clock size={12} className="text-slate-500" />
              <span className="text-[11px] text-slate-400"><span className="font-semibold text-slate-300">Best Time:</span> {post.optimal_posting_time}</span>
            </div>
          )}
          {post.engagement_goal && (
            <div className="flex items-center gap-2">
              <Target size={12} className="text-slate-500" />
              <span className="text-[11px] text-slate-400"><span className="font-semibold text-slate-300">Goal:</span> {post.engagement_goal}</span>
            </div>
          )}
        </div>
      )}

      {/* Caption */}
      <div className="px-5 py-4">
        {editing === 'caption' ? (
          <div>
            <textarea
              ref={textareaRef}
              value={captionText}
              onChange={e => setCaptionText(e.target.value)}
              rows={5}
              className="w-full px-3 py-2.5 rounded-lg text-sm text-white resize-y focus:outline-none"
              style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${primary}60` }}
              autoFocus
            />
            <div className="flex gap-2 mt-2">
              <button onClick={() => handleSave('caption')} disabled={saving}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all" style={{ background: primary }}>
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button onClick={() => { setEditing(null); setCaptionText(post.caption || '') }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition-all" style={{ background: 'rgba(255,255,255,0.06)' }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="group">
            <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">{captionText || 'No caption'}</p>
            {!readOnly && (
              <button onClick={() => setEditing('caption')}
                className="mt-1 opacity-0 group-hover:opacity-100 text-[10px] font-semibold text-slate-500 hover:text-white transition-all flex items-center gap-1">
                <Pencil size={10} /> Edit caption
              </button>
            )}
          </div>
        )}

        {/* Hashtags */}
        {hashtagText && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            {editing === 'hashtags' ? (
              <div>
                <textarea value={hashtagText} onChange={e => setHashtagText(e.target.value)} rows={2}
                  className="w-full px-3 py-2 rounded-lg text-xs text-blue-300 resize-y focus:outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${primary}40` }} autoFocus />
                <div className="flex gap-2 mt-2">
                  <button onClick={() => handleSave('hashtags')} disabled={saving}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white" style={{ background: primary }}>
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={() => { setEditing(null); setHashtagText(post.hashtags || '') }}
                    className="px-3 py-1.5 rounded-lg text-xs text-slate-400" style={{ background: 'rgba(255,255,255,0.06)' }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="group">
                <p className="text-xs text-blue-400/60 leading-relaxed">{hashtagText}</p>
                {!readOnly && (
                  <button onClick={() => setEditing('hashtags')}
                    className="mt-1 opacity-0 group-hover:opacity-100 text-[10px] font-semibold text-slate-500 hover:text-white transition-all flex items-center gap-1">
                    <Pencil size={10} /> Edit hashtags
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Posting tip */}
        {post.postingTip && (
          <div className="mt-3 px-3 py-2 rounded-lg" style={{ background: 'rgba(3,105,161,0.1)', border: '1px solid rgba(3,105,161,0.15)' }}>
            <p className="text-[11px] text-sky-400 font-medium">{post.postingTip}</p>
            {post.studioType && (
              <p className="text-[10px] text-slate-500 mt-0.5">
                Based on typical {({'yoga_pilates':'Yoga/Pilates','hiit_crossfit':'HIIT/CrossFit','dance_barre':'Dance/Barre','martial_arts':'Martial Arts','general_fitness':'General Fitness'})[post.studioType] || 'fitness'} audiences
              </p>
            )}
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 px-5 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
        <button onClick={() => handleCopy('caption')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:-translate-y-0.5"
          style={{ background: copied === 'caption' ? '#10b98120' : 'rgba(255,255,255,0.04)', color: copied === 'caption' ? '#10b981' : '#94a3b8', border: '1px solid rgba(255,255,255,0.06)' }}>
          {copied === 'caption' ? <Check size={12} /> : <Copy size={12} />}
          {copied === 'caption' ? 'Copied!' : 'Copy Caption'}
        </button>
        {hashtagText && (
          <button onClick={() => handleCopy('hashtags')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:-translate-y-0.5"
            style={{ background: copied === 'hashtags' ? '#10b98120' : 'rgba(255,255,255,0.04)', color: copied === 'hashtags' ? '#10b981' : '#94a3b8', border: '1px solid rgba(255,255,255,0.06)' }}>
            {copied === 'hashtags' ? <Check size={12} /> : <Copy size={12} />}
            {copied === 'hashtags' ? 'Copied!' : 'Copy Tags'}
          </button>
        )}
        {currentPhotoUrl && (
          <a href={currentPhotoUrl} download target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:-translate-y-0.5"
            style={{ background: 'rgba(255,255,255,0.04)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.06)', textDecoration: 'none' }}>
            <Download size={12} /> Image
          </a>
        )}
      </div>
    </div>
  )
}

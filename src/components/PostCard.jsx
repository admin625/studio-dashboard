/**
 * PostCard — Single post within a delivery detail.
 * Caption, hashtags, photo, metadata, edit/copy/download actions, inline photo editor.
 */
import { useState, useRef, useEffect } from 'react'
import { supabase, SUPABASE_URL, authedJsonHeaders } from '../lib/supabase'
import { downscaleToBase64 } from '../lib/image'
import { useApp } from '../context/AppContext'
import {
  Copy, Check, Pencil, Download, Clock, Target,
  Image as ImageIcon, Sparkles, Save, X, Loader2, ChevronDown, ChevronUp, Edit3, Wand2,
  Stamp, RotateCcw,
} from 'lucide-react'

const PLATFORM_LABEL = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', all: 'All Platforms' }
const FORMAT_COLORS = {
  feed_post: { bg: '#dcfce7', color: '#166534' },
  story: { bg: '#fef3c7', color: '#92400e' },
  thread: { bg: '#f3e8ff', color: '#6b21a8' },
  carousel: { bg: '#fce7f3', color: '#9d174d' },
}

const PROMPT_PLACEHOLDER = 'Describe the photo you want...'

// Watermark placement zones — must match the compositing service's ZONES tuple
// (logo_placement.py). Laid out as a 3-row grid for the picker.
const WM_ZONES = [
  { value: 'top-left', label: 'Top L', row: 0, col: 0 },
  { value: 'top-right', label: 'Top R', row: 0, col: 2 },
  { value: 'bottom-left', label: 'Bot L', row: 2, col: 0 },
  { value: 'bottom-center', label: 'Bot C', row: 2, col: 1 },
  { value: 'bottom-right', label: 'Bot R', row: 2, col: 2 },
]

export default function PostCard({ post, index, platform, deliveryId, readOnly }) {
  const {
    brandColorPrimary, resolvedStudioId, email, studioName, studioType, brandVoice, aiPhotoPrompt,
    brandLogoLightUrl, brandLogoDarkUrl, watermarkDefaultZone, watermarkDefaultVariant, update,
  } = useApp()
  const primary = brandColorPrimary || '#667eea'

  const [editing, setEditing] = useState(null) // 'caption' | 'hashtags' | null
  const [captionText, setCaptionText] = useState(post.caption || '')
  const [hashtagText, setHashtagText] = useState(post.hashtags || '')
  const [copied, setCopied] = useState(null) // 'caption' | 'hashtags' | null
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef(null)

  // Photo editor state
  const [editorOpen, setEditorOpen] = useState(false)
  // The workflow's Route Request appends a camera profile to the prompt and Prepare Save
  // stores that enhanced string. Re-seeding it here and regenerating appends ANOTHER copy,
  // so the block compounds once per edit — three refinements, three copies in the box the
  // user reads. Strip any trailing camera block(s) before seeding.
  // Requires "lens." so a user legitimately writing "photographed with my phone" is left
  // alone — only the generated block (which always names a lens) is stripped. Global so
  // an already-compounded prompt loses every copy, not just the first.
  const stripCameraProfile = (s) =>
    (s || '').replace(/\s*Photographed with [^\n]*?\slens\.[\s\S]*?(?=(\s*Photographed with )|$)/gi, '').trim()
  const initialPrompt = stripCameraProfile(
    post.image_prompt ||
    post.generation_prompt ||
    post.image_direction ||
    post.photo_keywords ||
    ''
  )
  const [promptText, setPromptText] = useState(initialPrompt || PROMPT_PLACEHOLDER)
  const [regenerating, setRegenerating] = useState(false)
  const [savingToLib, setSavingToLib] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [studioPhotos, setStudioPhotos] = useState([])
  const [photoTotal, setPhotoTotal] = useState(null) // server-side total, for truncation signal
  const [pickerFilter, setPickerFilter] = useState('all') // 'all' | 'uploaded' | 'ai_generated'
  const [pickerQuery, setPickerQuery] = useState('')
  const [loadingPhotos, setLoadingPhotos] = useState(false)
  const [overridePhotoUrl, setOverridePhotoUrl] = useState(null)
  const [overrideIsAI, setOverrideIsAI] = useState(null)
  // undefined = no override yet (use post values); null/string = explicit override after regenerate or pick
  const [overridePrompt, setOverridePrompt] = useState(undefined)
  const [editorMsg, setEditorMsg] = useState(null)
  const [promptExpanded, setPromptExpanded] = useState(false)

  // Watermark state. A studio with at least one logo variant gets the toggle ON
  // by default. Zone/variant pre-fill from the studio's last-used defaults; the
  // last successful apply persists back to those defaults.
  const hasLight = !!brandLogoLightUrl
  const hasDark = !!brandLogoDarkUrl
  const hasVariant = hasLight || hasDark
  const wmTouched = useRef(false)
  // Bug B guard: the content_deliveries photo_url this card last knew for its own element.
  // Sent as the optimistic-concurrency guard on every write, and updated on each successful
  // persist. Stable for the card's lifetime — the parent holds the delivery in state and does
  // not silently refetch, so post.photo_url is the load-time DB value and won't reset the ref.
  const dbPhotoUrlRef = useRef(post.photo_url)
  const [wmEnabled, setWmEnabled] = useState(hasVariant)
  const [wmZone, setWmZone] = useState(watermarkDefaultZone || 'bottom-right')
  const [wmVariant, setWmVariant] = useState(watermarkDefaultVariant || 'auto')
  const [wmApplying, setWmApplying] = useState(false)
  const [wmSourceUrl, setWmSourceUrl] = useState(null) // un-watermarked base to composite from
  const [wmAppliedUrl, setWmAppliedUrl] = useState(null) // watermarked result this session

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

  // Default the watermark toggle ON once we know the studio has a logo variant
  // (logos may load into AppContext after first render). Stops once the user
  // manually toggles, so we never override an explicit choice.
  useEffect(() => {
    if (!wmTouched.current) setWmEnabled(hasVariant)
  }, [hasVariant])

  // Keep the manual-variant choice valid for what the studio actually uploaded.
  useEffect(() => {
    if (wmVariant === 'light' && !hasLight) setWmVariant(hasDark ? 'dark' : 'auto')
    if (wmVariant === 'dark' && !hasDark) setWmVariant(hasLight ? 'light' : 'auto')
  }, [hasLight, hasDark, wmVariant])

  // Picker sectioning — mirrors the Photos page tabs so both surfaces behave the same.
  const pickerUploaded = studioPhotos.filter(p => p.source !== 'ai_generated')
  const pickerAI = studioPhotos.filter(p => p.source === 'ai_generated')
  const pickerBase =
    pickerFilter === 'uploaded' ? pickerUploaded
    : pickerFilter === 'ai_generated' ? pickerAI
    : studioPhotos
  // Search over what actually distinguishes near-duplicates: the prompt that made them,
  // and the original filename. Client-side over already-loaded rows — no extra query.
  const pickerQ = pickerQuery.trim().toLowerCase()
  const pickerList = pickerQ
    ? pickerBase.filter(p =>
        `${p.file_name || ''} ${p.generation_prompt || ''} ${p.keywords || ''}`
          .toLowerCase().includes(pickerQ))
    : pickerBase
  const relDate = (d) => {
    if (!d) return ''
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000)
    if (days < 1) return 'today'
    if (days < 7) return `${days}d`
    if (days < 60) return `${Math.floor(days / 7)}w`
    return `${Math.floor(days / 30)}mo`
  }

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

  // Caption/hashtag save — atomic, guarded single-element write (Bug B fix). No whole-array
  // read-modify-write, so a concurrent edit to a sibling post can never be clobbered, and the
  // photo_url guard confirms we are still pointed at the element this card rendered.
  const handleSave = async (field) => {
    setSaving(true)
    try {
      const value = field === 'caption' ? captionText : hashtagText
      const { data, error } = await supabase.rpc('update_delivery_post_field', {
        p_delivery_id: deliveryId,
        p_platform: platform,
        p_index: index,
        p_expected_url: dbPhotoUrlRef.current ?? null,
        p_patch: { [field]: value },
      })
      if (error) throw new Error(error.message || 'Save failed')
      if (!data || data.ok !== true) {
        flashMsg({ type: 'error', text: 'This post changed since you opened it — reload the page before editing.' })
      }
    } catch (e) {
      console.error('[PostCard] Save failed:', e)
      flashMsg({ type: 'error', text: e.message || 'Save failed' })
    }
    setSaving(false)
    setEditing(null)
  }

  // Persist a photo change to this post's element in content_deliveries — atomic + guarded.
  // Writes ONLY if the element at this card's index still shows the photo_url we last knew
  // (dbPhotoUrlRef); a guard miss means the array changed under us (reorder / concurrent edit),
  // so we throw and let the caller surface a reload prompt rather than write to the wrong post.
  const persistPhotoChange = async (newUrl, extraFields = {}) => {
    const { data, error } = await supabase.rpc('update_delivery_post_field', {
      p_delivery_id: deliveryId,
      p_platform: platform,
      p_index: index,
      p_expected_url: dbPhotoUrlRef.current ?? null,
      p_patch: { photo_url: newUrl, ...extraFields },
    })
    if (error) throw new Error(error.message || 'Save failed')
    if (!data || data.ok !== true) {
      throw new Error('This post changed since you opened it — reload the page to get the latest before editing.')
    }
    dbPhotoUrlRef.current = newUrl
  }

  // Load studio photos for the picker (lazy, only on open)
  const loadStudioPhotos = async () => {
    if (!resolvedStudioId) return
    setLoadingPhotos(true)
    try {
      // generation_prompt + upload_date were previously NOT selected — the query ordered by
      // a column it never fetched, so tiles had nothing to tell near-duplicates apart with.
      // Limit was 60 with no signal: TLK had 69 active photos, so its 9 OLDEST — all
      // uploaded originals (LK_frontLobby, LK_meetingRoom, …) — were silently invisible.
      const { data, count } = await supabase
        .from('studio_photos')
        .select(
          'id, photo_url, thumbnail_url, keywords, source, tags, file_name, generation_prompt, upload_date',
          { count: 'exact' }
        )
        .eq('studio_id', resolvedStudioId)
        .eq('is_active', true)
        .order('upload_date', { ascending: false })
        .limit(200)
      if (data) setStudioPhotos(data)
      if (typeof count === 'number') setPhotoTotal(count)
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
      // Bind the CURRENTLY DISPLAYED image as the edit source. Both values are read here,
      // BEFORE persistPhotoChange() below sets matched_photo_id: null — that ordering is the
      // whole lineage chain. Without the source image the model has nothing to edit and
      // generates from scratch, which is why "add our logo to the ball" produced a new scene.
      const srcUrl = currentPhotoUrl || null
      const srcId = post.matched_photo_id || null
      let src = null
      if (srcUrl) {
        try {
          src = await downscaleToBase64(srcUrl, 1024)
        } catch (e) {
          // NEVER silent. Degrading to generate-from-scratch here produces a plausible
          // WRONG result the user cannot distinguish from a real edit — which is the bug
          // this whole change exists to fix. Fail loudly with a distinct message so
          // "couldn't read the source image" never looks like "the model declined".
          console.error('[FCA] edit source unreadable:', srcUrl, e)
          throw new Error(
            `Couldn't read the current image to edit it (${e.message || 'unknown error'}). Reload the page and try again.`
          )
        }
      }

      // Same NEVER-silent rule as the source-image read above: a missing session must
      // fail with its own message, not look like the model declining the prompt.
      const authHeaders = await authedJsonHeaders()
      if (!authHeaders) {
        throw new Error('Your session has expired. Reload the page and sign in again.')
      }

      const res = await fetch('/.netlify/functions/proxy-webhook?target=ai-photo', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          // Pinned deliberately. 'auto' lets Route Request match /logo|watermark|typography/
          // and route to flux2_pro, which is text-to-image only and silently DROPS
          // image_base64 — reintroducing the generate-from-scratch bug this fixes.
          // 'auto' belongs on the GENERATE path, never on EDIT.
          platform: 'nano_banana_pro',
          prompt,
          ...(src ? { edit_prompt: prompt, image_base64: src.base64, mime_type: src.mime } : {}),
          ...(srcId ? { reference_photo_ids: [srcId] } : {}),
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
      setWmAppliedUrl(null)
      setWmSourceUrl(null)
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
    setWmAppliedUrl(null)
    setWmSourceUrl(null)
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
    if (brandColorPrimary) aesthetic.push(`brand color ${brandColorPrimary}`)
    if (brandVoice) aesthetic.push(`voice ${brandVoice}`)
    if (aesthetic.length) parts.push(`Studio aesthetic: ${aesthetic.join(', ')}.`)
    if (aiPhotoPrompt) parts.push(aiPhotoPrompt.trim())
    return parts.join('\n\n')
  }

  const openAiGen = () => {
    setAiGenPrompt(buildAiPrompt())
    setAiGenOpen(true)
  }

  const startAiGeneration = async () => {
    const prompt = (aiGenPrompt || '').trim()
    if (!prompt || !resolvedStudioId) {
      flashMsg({ type: 'error', text: 'Prompt required' })
      return
    }
    const authHeaders = await authedJsonHeaders()
    if (!authHeaders) {
      flashMsg({ type: 'error', text: 'Your session has expired. Reload the page and sign in again.' })
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
      headers: authHeaders,
      body: JSON.stringify({
        studio_id: resolvedStudioId,
        platform: 'nano_banana_pro',
        prompt,
        width: 1024,
        height: 1024,
        content_focus: (post.caption || '').slice(0, 120),
        _source: 'post_picker_generate_button',
      }),
    }).then(r => {
      if (!r.ok) {
        setAiGenerating(false)
        flashMsg({ type: 'error', text: `Could not start generation (${r.status})` })
      }
    }).catch(err => {
      setAiGenerating(false)
      flashMsg({ type: 'error', text: err.message || 'Network error starting generation' })
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

  // Persist the last-used zone/variant to the studio's defaults so the next post
  // (and next session) pre-fills the same choice. Fire-and-forget; non-fatal.
  const persistWatermarkDefault = async (zone, variant) => {
    try {
      if (resolvedStudioId) {
        await supabase.from('studio_accounts')
          .update({ watermark_default_zone: zone, watermark_default_variant: variant })
          .eq('id', resolvedStudioId)
      }
      update({ watermarkDefaultZone: zone, watermarkDefaultVariant: variant })
    } catch (e) {
      console.warn('[PostCard] watermark default persist failed:', e)
    }
  }

  const applyWatermark = async () => {
    if (!hasVariant || !resolvedStudioId) return
    // Composite from the original un-watermarked image, never from an already-
    // stamped result (avoids double logos when re-applying with a new zone).
    const source = wmAppliedUrl ? wmSourceUrl : currentPhotoUrl
    if (!source) {
      flashMsg({ type: 'error', text: 'No image to watermark yet' })
      return
    }
    setWmApplying(true)
    setEditorMsg(null)
    try {
      const res = await fetch('/.netlify/functions/watermark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: source,
          studio_id: resolvedStudioId,
          logo_light_url: brandLogoLightUrl || null,
          logo_dark_url: brandLogoDarkUrl || null,
          zone: wmZone,
          variant: wmVariant,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.watermarked_url) {
        throw new Error(data.error || data.detail || 'Watermark failed')
      }
      if (data.watermarked === false) {
        flashMsg({ type: 'error', text: 'No logo variant available to apply' })
        setWmApplying(false)
        return
      }
      setWmSourceUrl(source)
      setWmAppliedUrl(data.watermarked_url)
      setOverridePhotoUrl(data.watermarked_url)
      await persistPhotoChange(data.watermarked_url, {
        watermark_applied: true,
        watermark_zone: data.zone || wmZone,
        watermark_variant: data.variant_used || wmVariant,
        original_photo_url: source,
      })
      persistWatermarkDefault(wmZone, wmVariant)
      flashMsg({ type: 'success', text: `Watermark applied (${data.variant_used || wmVariant})` })
    } catch (e) {
      flashMsg({ type: 'error', text: e.message || 'Watermark failed' })
    }
    setWmApplying(false)
  }

  const removeWatermark = async () => {
    if (!wmSourceUrl) return
    setOverridePhotoUrl(wmSourceUrl)
    setWmAppliedUrl(null)
    try {
      await persistPhotoChange(wmSourceUrl, {
        watermark_applied: false,
        watermark_zone: null,
        watermark_variant: null,
      })
      flashMsg({ type: 'success', text: 'Watermark removed' })
    } catch (e) {
      flashMsg({ type: 'error', text: 'Could not remove watermark' })
    }
  }

  const toggleWatermark = () => {
    wmTouched.current = true
    setWmEnabled(prev => {
      const next = !prev
      if (!next && wmAppliedUrl) removeWatermark()
      return next
    })
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
          <img src={currentPhotoUrl} alt="Post" className="w-full max-h-96 object-contain" />
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

              {/* ── Logo watermark ── (only when the studio has uploaded a variant) */}
              {hasVariant && (
                <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Stamp size={13} style={{ color: wmEnabled ? primary : '#64748b' }} />
                      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: wmEnabled ? '#cbd5e1' : '#64748b' }}>
                        Logo Watermark
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={toggleWatermark}
                      role="switch"
                      aria-checked={wmEnabled}
                      className="relative w-9 h-5 rounded-full transition-colors flex-shrink-0"
                      style={{ background: wmEnabled ? primary : 'rgba(255,255,255,0.12)' }}
                    >
                      <span
                        className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                        style={{ transform: wmEnabled ? 'translateX(16px)' : 'none' }}
                      />
                    </button>
                  </div>

                  {wmEnabled && (
                    <div className="flex flex-col sm:flex-row gap-5">
                      {/* Placement picker — 3×3 grid, 5 active zones */}
                      <div>
                        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-2">Placement</p>
                        <div className="grid grid-cols-3 gap-1" style={{ width: 84 }}>
                          {[0, 1, 2].map(row =>
                            [0, 1, 2].map(col => {
                              const z = WM_ZONES.find(zn => zn.row === row && zn.col === col)
                              if (!z) return <div key={`${row}-${col}`} className="aspect-square rounded-sm" style={{ background: 'rgba(255,255,255,0.02)' }} />
                              const sel = wmZone === z.value
                              return (
                                <button
                                  key={z.value}
                                  type="button"
                                  onClick={() => setWmZone(z.value)}
                                  title={z.value}
                                  className="aspect-square rounded-sm transition-all flex items-center justify-center"
                                  style={{
                                    background: sel ? primary : 'rgba(255,255,255,0.06)',
                                    border: `1px solid ${sel ? primary : 'rgba(255,255,255,0.1)'}`,
                                  }}
                                >
                                  <span className="rounded-full" style={{ width: 5, height: 5, background: sel ? '#fff' : 'rgba(255,255,255,0.35)' }} />
                                </button>
                              )
                            })
                          )}
                        </div>
                      </div>

                      {/* Variant selector + actions */}
                      <div className="flex-1">
                        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-2">Logo version</p>
                        <div className="inline-flex rounded-lg overflow-hidden mb-3" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
                          {[
                            { v: 'auto', label: 'Auto', show: true },
                            { v: 'light', label: 'Light', show: hasLight },
                            { v: 'dark', label: 'Dark', show: hasDark },
                          ].filter(o => o.show).map((o, i) => {
                            const sel = wmVariant === o.v
                            return (
                              <button
                                key={o.v}
                                type="button"
                                onClick={() => setWmVariant(o.v)}
                                className="px-3 py-1.5 text-[11px] font-bold transition-colors"
                                style={{
                                  background: sel ? primary : 'transparent',
                                  color: sel ? '#fff' : '#94a3b8',
                                  borderLeft: i > 0 ? '1px solid rgba(255,255,255,0.1)' : 'none',
                                }}
                              >
                                {o.label}
                              </button>
                            )
                          })}
                        </div>
                        {wmVariant === 'auto' && hasLight && hasDark && (
                          <p className="text-[10px] text-slate-500 mb-3 -mt-1">Picks light or dark automatically based on the photo behind the logo.</p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={applyWatermark}
                            disabled={wmApplying || !currentPhotoUrl}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                            style={{ background: primary, color: '#fff' }}
                          >
                            {wmApplying ? <Loader2 size={12} className="animate-spin" /> : <Stamp size={12} />}
                            {wmApplying ? 'Applying…' : wmAppliedUrl ? 'Re-apply' : 'Apply Watermark'}
                          </button>
                          {wmAppliedUrl && (
                            <button
                              type="button"
                              onClick={removeWatermark}
                              disabled={wmApplying}
                              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all hover:-translate-y-0.5 disabled:opacity-60"
                              style={{ background: 'rgba(255,255,255,0.06)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.08)' }}
                            >
                              <RotateCcw size={12} /> Remove
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

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
                    <>
                    <div className="flex items-center gap-1 mb-2 flex-wrap">
                      {[
                        { label: 'All', value: 'all', count: studioPhotos.length },
                        { label: 'Studio Photos', value: 'uploaded', count: pickerUploaded.length },
                        { label: 'AI Generated', value: 'ai_generated', count: pickerAI.length },
                      ].map(tab => (
                        <button
                          key={tab.value}
                          onClick={() => setPickerFilter(tab.value)}
                          className="px-2 py-1 rounded text-[10px] font-medium transition-colors"
                          style={{
                            background: pickerFilter === tab.value ? `${primary}25` : 'rgba(255,255,255,0.04)',
                            color: pickerFilter === tab.value ? primary : '#94a3b8',
                            border: `1px solid ${pickerFilter === tab.value ? `${primary}60` : 'transparent'}`,
                          }}
                        >
                          {tab.label} ({tab.count})
                        </button>
                      ))}
                      {typeof photoTotal === 'number' && photoTotal > studioPhotos.length && (
                        <span className="text-[10px] text-amber-400/80">
                          showing {studioPhotos.length} of {photoTotal}
                        </span>
                      )}
                      <input
                        value={pickerQuery}
                        onChange={e => setPickerQuery(e.target.value)}
                        placeholder="Search name or prompt..."
                        className="ml-auto px-2 py-1 rounded text-[10px] outline-none"
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: '#e2e8f0',
                          minWidth: 130,
                        }}
                      />
                    </div>
                    {pickerList.length === 0 ? (
                      <p className="text-xs text-slate-400 py-4 text-center">
                        {pickerQ
                          ? `No photos match "${pickerQuery.trim()}".`
                          : `No ${pickerFilter === 'ai_generated' ? 'AI-generated' : 'studio'} photos yet.`}
                      </p>
                    ) : (
                    <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2 max-h-72 overflow-y-auto">
                      {pickerList.map(photo => {
                        const isCurrent = photo.photo_url === currentPhotoUrl
                        const photoIsAI = photo.source === 'ai_generated'
                        const tileHint = [photo.generation_prompt || photo.file_name || photo.keywords, relDate(photo.upload_date)]
                          .filter(Boolean).join(' · ')
                        return (
                          <button
                            key={photo.id}
                            onClick={() => handlePickPhoto(photo)}
                            title={tileHint}
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
                            {photo.upload_date && (
                              <span
                                className="absolute top-1 right-1 px-1 py-0.5 rounded text-[8px] font-medium"
                                style={{ background: 'rgba(0,0,0,0.6)', color: '#cbd5e1', backdropFilter: 'blur(4px)' }}
                              >
                                {relDate(photo.upload_date)}
                              </span>
                            )}
                            {photoIsAI && photo.generation_prompt && (
                              <span
                                className="absolute bottom-0 left-0 right-0 px-1 py-0.5 text-[7px] leading-tight text-left truncate"
                                style={{ background: 'rgba(0,0,0,0.65)', color: '#e2e8f0', backdropFilter: 'blur(4px)' }}
                              >
                                {photo.generation_prompt}
                              </span>
                            )}
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
                    </>
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
              <span className="text-base font-bold text-slate-400"><span className="text-slate-300">Best Time:</span> {post.optimal_posting_time}</span>
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

import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import Layout from '../components/Layout'
import {
  Upload, Image as ImageIcon, Trash2, X, Check,
  AlertCircle, Loader2, Plus, Eye,
  Sparkles, Save, RefreshCw,
} from 'lucide-react'

export default function Photos() {
  const app = useApp()
  const primary = app.brandColorPrimary || '#667eea'
  const isOwner = app.role === 'studio_owner'

  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [pendingFiles, setPendingFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState(null)
  const [category, setCategory] = useState('activity')
  const [dragOver, setDragOver] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [filter, setFilter] = useState('all')
  const fileRef = useRef(null)

  // AI Reimagine state (lives inside the lightbox)
  const [reimagineOpen, setReimagineOpen] = useState(false)
  const [reimaginePrompt, setReimaginePrompt] = useState('')
  const [reimagineStatus, setReimagineStatus] = useState('idle') // 'idle' | 'generating' | 'preview'
  const [reimagineResult, setReimagineResult] = useState(null)
  const [reimagineError, setReimagineError] = useState(null)
  const [reimagineSaving, setReimagineSaving] = useState(null) // null | 'new' | 'replace'

  const fetchPhotos = useCallback(async () => {
    if (!app.resolvedStudioId) return
    const { data } = await supabase.from('studio_photos')
      .select('*')
      .eq('studio_id', app.resolvedStudioId)
      .eq('is_active', true)
      .order('upload_date', { ascending: false })
    if (data) setPhotos(data)
    setLoading(false)
  }, [app.resolvedStudioId])

  useEffect(() => { fetchPhotos() }, [fetchPhotos])

  const handleFiles = (fileList) => {
    const TYPES = ['image/jpeg', 'image/png', 'image/webp']
    const MAX = 25 * 1024 * 1024
    const added = []
    for (const f of fileList) {
      if (!TYPES.includes(f.type)) continue
      if (f.size > MAX) continue
      if (pendingFiles.some(x => x.name === f.name && x.size === f.size)) continue
      added.push(f)
    }
    setPendingFiles(prev => [...prev, ...added])
  }

  const startUpload = async () => {
    if (!pendingFiles.length || !app.resolvedStudioId) return
    setUploading(true)
    let ok = 0, fail = 0
    for (const file of pendingFiles) {
      try {
        const path = `studio-${app.resolvedStudioId}/${Date.now()}-${file.name}`
        const { error: ue } = await supabase.storage.from('studio-photos').upload(path, file, { contentType: file.type })
        if (ue) throw ue
        const { data: urlData } = supabase.storage.from('studio-photos').getPublicUrl(path)
        const { error: ie } = await supabase.from('studio_photos').insert({
          photo_url: urlData.publicUrl,
          file_name: file.name,
          file_size: file.size,
          keywords: category,
          tags: category === 'headshot' ? [] : null,
          uploaded_by: app.email,
          is_active: true,
          studio_id: app.resolvedStudioId,
        })
        if (ie) throw ie
        ok++
      } catch { fail++ }
    }
    setPendingFiles([])
    setUploading(false)
    setUploadMsg(fail === 0
      ? { type: 'success', text: `${ok} photo${ok > 1 ? 's' : ''} uploaded!` }
      : { type: 'error', text: `${ok} uploaded, ${fail} failed.` })
    setTimeout(() => setUploadMsg(null), 5000)
    fetchPhotos()
  }

  const deletePhoto = async (photo) => {
    setDeleting(photo.id)
    try {
      const { error } = await supabase.from('studio_photos')
        .update({ is_active: false })
        .eq('id', photo.id)
      if (error) throw error
      setPhotos(prev => prev.filter(p => p.id !== photo.id))
    } catch (err) {
      setUploadMsg({ type: 'error', text: 'Delete failed: ' + err.message })
      setTimeout(() => setUploadMsg(null), 5000)
    }
    setDeleting(null)
  }

  // ── AI Reimagine handlers ──

  const seedPromptForPhoto = (photo) => {
    if (!photo) return ''
    const photoIsAI = photo.source === 'ai_generated'
    if (photoIsAI && photo.generation_prompt) return photo.generation_prompt
    const keyword = photo.keywords || photo.file_name || (photo.tags && photo.tags[0]) || ''
    return keyword ? `A fitness studio photo of ${keyword}` : 'A fitness studio photo'
  }

  const resetReimagine = () => {
    setReimagineOpen(false)
    setReimagineStatus('idle')
    setReimagineResult(null)
    setReimagineError(null)
    setReimagineSaving(null)
  }

  const openReimagine = () => {
    setReimaginePrompt(seedPromptForPhoto(lightbox))
    setReimagineStatus('idle')
    setReimagineResult(null)
    setReimagineError(null)
    setReimagineOpen(true)
  }

  const closeLightbox = () => {
    setLightbox(null)
    resetReimagine()
  }

  const handleReimagineGenerate = async () => {
    const prompt = (reimaginePrompt || '').trim()
    if (!prompt || !app.resolvedStudioId) {
      setReimagineError('Write a prompt first')
      return
    }
    setReimagineStatus('generating')
    setReimagineError(null)
    try {
      const res = await fetch('/.netlify/functions/proxy-webhook?target=ai-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'nano_banana_pro',
          prompt,
          width: 1024,
          height: 1024,
          studio_id: app.resolvedStudioId,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.image_url) {
        throw new Error(data.error || data.detail || 'Image generation failed')
      }
      setReimagineResult(data.image_url)
      setReimagineStatus('preview')
    } catch (e) {
      setReimagineError(e.message || 'Generation failed')
      setReimagineStatus('idle')
    }
  }

  const handleSaveAsNew = async () => {
    if (!reimagineResult || !app.resolvedStudioId) return
    setReimagineSaving('new')
    setReimagineError(null)
    try {
      const { error } = await supabase.from('studio_photos').insert({
        studio_id: app.resolvedStudioId,
        photo_url: reimagineResult,
        keywords: 'ai_generated',
        source: 'ai_generated',
        generation_model: 'nano_banana_pro',
        generation_prompt: reimaginePrompt,
        uploaded_by: app.email || null,
        is_active: true,
        tags: null,
      })
      if (error) throw error
      await fetchPhotos()
      closeLightbox()
    } catch (e) {
      setReimagineError('Save failed: ' + e.message)
      setReimagineSaving(null)
    }
  }

  const handleReplaceOriginal = async () => {
    if (!reimagineResult || !lightbox?.id) return
    setReimagineSaving('replace')
    setReimagineError(null)
    try {
      const { error } = await supabase.from('studio_photos')
        .update({
          photo_url: reimagineResult,
          generation_prompt: reimaginePrompt,
          generation_model: 'nano_banana_pro',
        })
        .eq('id', lightbox.id)
      if (error) throw error
      await fetchPhotos()
      closeLightbox()
    } catch (e) {
      setReimagineError('Replace failed: ' + e.message)
      setReimagineSaving(null)
    }
  }

  const isAiPhoto = (p) => p.source === 'ai_generated'
  const uploaded = photos.filter(p => !isAiPhoto(p))
  const aiPhotos = photos.filter(isAiPhoto)
  const filtered =
    filter === 'all' ? photos
    : filter === 'uploaded' ? uploaded
    : filter === 'ai_generated' ? aiPhotos
    : photos

  const formatSize = (bytes) => {
    if (!bytes) return ''
    if (bytes < 1024) return bytes + 'B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + 'KB'
    return (bytes / 1048576).toFixed(1) + 'MB'
  }

  const showingPreview = reimagineStatus === 'preview' && !!reimagineResult

  return (
    <Layout>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-6 h-px" style={{ background: primary }} />
            <span className="text-[10px] font-semibold tracking-[0.2em] uppercase" style={{ color: primary }}>Media</span>
          </div>
          <h1 className="text-white" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 'clamp(1.8rem, 4vw, 2.6rem)', letterSpacing: '0.02em' }}>
            Photo Library
          </h1>
        </div>
        {isOwner && (
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-bold transition-all hover:-translate-y-0.5"
            style={{ background: primary, color: '#fff', boxShadow: `0 4px 20px ${primary}40` }}
          >
            <Plus size={16} />
            <span className="hidden sm:inline">Add Photos</span>
            <span className="sm:hidden">Add</span>
          </button>
        )}
      </div>

      {/* Filter tabs */}
      {!loading && photos.length > 0 && (
        <div className="flex items-center gap-4 mb-6">
          {[
            { label: 'All', value: 'all', count: photos.length },
            { label: 'Studio Photos', value: 'uploaded', count: uploaded.length },
            { label: 'AI Generated', value: 'ai_generated', count: aiPhotos.length },
          ].map(tab => (
            <button
              key={tab.value}
              onClick={() => setFilter(tab.value)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all"
              style={{
                background: filter === tab.value ? `${primary}20` : 'rgba(255,255,255,0.03)',
                color: filter === tab.value ? primary : '#64748b',
                border: filter === tab.value ? `1px solid ${primary}40` : '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {tab.label} <span className="ml-1 opacity-60">{tab.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Upload zone (owner only) */}
      {isOwner && (
        <>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={e => { handleFiles(e.target.files); e.target.value = '' }}
          />

          <div
            className={`flex items-center justify-center gap-3 py-6 rounded-xl mb-6 cursor-pointer transition-all ${dragOver ? 'scale-[1.005]' : ''}`}
            style={{
              border: `1.5px dashed ${dragOver ? primary : 'rgba(255,255,255,0.08)'}`,
              background: dragOver ? `${primary}08` : 'rgba(255,255,255,0.02)',
            }}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
          >
            <Upload size={18} style={{ color: 'rgba(255,255,255,0.15)' }} />
            <p className="text-sm text-slate-400">Drop photos here or click to browse</p>
            <span className="text-[10px] text-slate-500">JPG, PNG, WebP — max 25MB</span>
          </div>

          {pendingFiles.length > 0 && (
            <div className="rounded-xl mb-6 overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="px-5 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span className="text-xs font-bold text-white uppercase tracking-wider">{pendingFiles.length} file{pendingFiles.length > 1 ? 's' : ''} ready</span>
              </div>
              <div className="p-4 space-y-1.5">
                {pendingFiles.map((f, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <span className="text-xs text-slate-300 truncate flex-1">{f.name}</span>
                    <span className="text-[10px] text-slate-500 mx-3">{formatSize(f.size)}</span>
                    <button onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))} className="text-slate-500 hover:text-red-400 transition-colors"><X size={12} /></button>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 flex items-center gap-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                <select
                  value={category}
                  onChange={e => setCategory(e.target.value)}
                  className="px-3 py-2 rounded-lg text-xs text-white appearance-none"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <option value="activity">Activity / Studio</option>
                  <option value="headshot">Instructor Headshot</option>
                </select>
                <button
                  onClick={startUpload}
                  disabled={uploading}
                  className="px-5 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all hover:-translate-y-0.5 disabled:opacity-60"
                  style={{ background: primary, color: '#fff' }}
                >
                  {uploading ? 'Uploading...' : 'Upload All'}
                </button>
                <button
                  onClick={() => setPendingFiles([])}
                  className="px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-white transition-colors"
                  style={{ background: 'rgba(255,255,255,0.04)' }}
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {uploadMsg && (
            <div className="mb-6 px-4 py-3 rounded-xl text-xs font-semibold flex items-center gap-2"
              style={{
                background: uploadMsg.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                color: uploadMsg.type === 'success' ? '#10b981' : '#ef4444',
                border: `1px solid ${uploadMsg.type === 'success' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
              }}>
              {uploadMsg.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
              {uploadMsg.text}
            </div>
          )}
        </>
      )}

      {/* Gallery */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin mb-4" style={{ color: primary }} />
          <p className="text-slate-400 text-sm">Loading photos...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <ImageIcon size={48} className="mx-auto mb-4" style={{ color: 'rgba(255,255,255,0.1)' }} />
          <p className="text-white text-lg font-semibold mb-1">
            {photos.length === 0
              ? 'No photos yet'
              : filter === 'ai_generated'
                ? 'No AI generated photos yet'
                : filter === 'uploaded'
                  ? 'No studio photos uploaded yet'
                  : 'No photos in this category'}
          </p>
          <p className="text-slate-400 text-sm">
            {photos.length === 0
              ? 'Upload studio photos or save AI images from the photo editor.'
              : filter === 'ai_generated'
                ? 'Generate images in the photo editor and click Save to Library.'
                : 'Try a different filter.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {filtered.map(photo => {
            const photoIsAI = isAiPhoto(photo)
            const label = photoIsAI
              ? (photo.generation_prompt || 'AI Generated')
              : (photo.keywords === 'headshot'
                  ? (photo.tags?.[0] || 'Headshot')
                  : (photo.keywords || photo.file_name || 'Studio Photo'))
            const isDeleting = deleting === photo.id

            return (
              <div
                key={photo.id}
                className="group relative aspect-square rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5"
                style={{ background: 'rgba(255,255,255,0.04)' }}
              >
                <img
                  src={photo.thumbnail_url || photo.photo_url}
                  alt={label}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />

                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all duration-200 flex items-center justify-center gap-3 opacity-0 group-hover:opacity-100">
                  <button
                    onClick={() => setLightbox(photo)}
                    className="w-9 h-9 rounded-full flex items-center justify-center bg-white/20 hover:bg-white/30 backdrop-blur-sm transition-all"
                  >
                    <Eye size={16} className="text-white" />
                  </button>
                  {isOwner && (
                    <button
                      onClick={() => deletePhoto(photo)}
                      disabled={isDeleting}
                      className="w-9 h-9 rounded-full flex items-center justify-center bg-red-500/20 hover:bg-red-500/40 backdrop-blur-sm transition-all"
                    >
                      {isDeleting
                        ? <Loader2 size={14} className="animate-spin text-red-300" />
                        : <Trash2 size={14} className="text-red-300" />
                      }
                    </button>
                  )}
                </div>

                <span
                  className="absolute top-2 left-2 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider"
                  style={{
                    background: photoIsAI ? 'rgba(139,92,246,0.3)' : 'rgba(16,185,129,0.3)',
                    color: photoIsAI ? '#c4b5fd' : '#6ee7b7',
                    backdropFilter: 'blur(8px)',
                  }}
                >
                  {photoIsAI ? 'AI' : 'Studio'}
                </span>

                <div className="absolute bottom-0 left-0 right-0 p-2"
                  style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.7))' }}>
                  <p className="text-[10px] text-white/80 truncate">{label}</p>
                  {photo.file_size && (
                    <p className="text-[9px] text-white/40">{formatSize(photo.file_size)}</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[100] flex flex-col p-4 sm:p-6"
          style={{ background: 'rgba(0,0,0,0.92)' }}
          onClick={closeLightbox}
        >
          <button
            className="absolute top-6 right-6 w-10 h-10 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 transition-colors z-10"
            onClick={closeLightbox}
          >
            <X size={20} className="text-white" />
          </button>

          {/* Image area */}
          <div className="flex-1 flex items-center justify-center min-h-0 pb-4" onClick={e => e.stopPropagation()}>
            {showingPreview ? (
              <div className="w-full max-w-6xl grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
                <div className="flex flex-col items-center min-h-0">
                  <div className="relative w-full flex justify-center">
                    <img
                      src={lightbox.photo_url}
                      alt="Original"
                      className="max-w-full max-h-[60vh] rounded-xl object-contain"
                    />
                  </div>
                  <span className="mt-3 text-[10px] font-bold uppercase tracking-wider text-white/50">Original</span>
                </div>
                <div className="flex flex-col items-center min-h-0">
                  <div className="relative w-full flex justify-center">
                    <img
                      src={reimagineResult}
                      alt="Reimagined"
                      className="max-w-full max-h-[60vh] rounded-xl object-contain"
                      style={{ boxShadow: '0 0 0 2px var(--brand-primary)' }}
                    />
                  </div>
                  <span className="mt-3 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--brand-primary)' }}>Reimagined</span>
                </div>
              </div>
            ) : (
              <img
                src={lightbox.photo_url}
                alt={lightbox.keywords || 'Photo'}
                className="max-w-full max-h-[75vh] rounded-xl object-contain"
              />
            )}
          </div>

          {/* Footer panel */}
          <div className="w-full max-w-3xl mx-auto" onClick={e => e.stopPropagation()}>
            {reimagineOpen ? (
              // ── Reimagine panel ──
              <div
                className="rounded-xl p-5"
                style={{ background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                {!showingPreview ? (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <Sparkles size={12} style={{ color: 'var(--brand-primary)' }} />
                      <label className="text-[10px] font-bold uppercase tracking-wider text-white/70">
                        Reimagine with AI
                      </label>
                    </div>
                    <textarea
                      value={reimaginePrompt}
                      onChange={e => setReimaginePrompt(e.target.value)}
                      disabled={reimagineStatus === 'generating'}
                      rows={3}
                      placeholder="Describe the photo you want..."
                      className="w-full px-3 py-2.5 rounded-lg text-sm text-white resize-y focus:outline-none mb-3 disabled:opacity-60"
                      style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}
                    />
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={handleReimagineGenerate}
                        disabled={reimagineStatus === 'generating' || !reimaginePrompt.trim()}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                        style={{ background: 'var(--brand-primary)', color: '#fff' }}
                      >
                        {reimagineStatus === 'generating'
                          ? <Loader2 size={12} className="animate-spin" />
                          : <Sparkles size={12} />}
                        {reimagineStatus === 'generating' ? 'Creating your image...' : 'Generate'}
                      </button>
                      <button
                        onClick={resetReimagine}
                        disabled={reimagineStatus === 'generating'}
                        className="px-4 py-2 rounded-lg text-xs font-semibold text-white/60 hover:text-white transition-colors disabled:opacity-40"
                        style={{ background: 'rgba(255,255,255,0.06)' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-white/70 mb-3 text-center font-medium">How does this look?</p>
                    <div className="flex items-center gap-2 justify-center flex-wrap">
                      <button
                        onClick={handleSaveAsNew}
                        disabled={reimagineSaving !== null}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all hover:-translate-y-0.5 disabled:opacity-60"
                        style={{ background: 'var(--brand-primary)', color: '#fff' }}
                      >
                        {reimagineSaving === 'new' ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                        {reimagineSaving === 'new' ? 'Saving...' : 'Save as New Photo'}
                      </button>
                      <button
                        onClick={handleReplaceOriginal}
                        disabled={reimagineSaving !== null}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all hover:-translate-y-0.5 disabled:opacity-60"
                        style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff' }}
                      >
                        {reimagineSaving === 'replace' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        {reimagineSaving === 'replace' ? 'Replacing...' : 'Replace Original'}
                      </button>
                      <button
                        onClick={resetReimagine}
                        disabled={reimagineSaving !== null}
                        className="px-4 py-2 rounded-lg text-xs font-semibold text-white/60 hover:text-white transition-colors disabled:opacity-40"
                        style={{ background: 'rgba(255,255,255,0.06)' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}

                {reimagineError && (
                  <div className="mt-3 px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2"
                    style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
                    <AlertCircle size={12} />
                    {reimagineError}
                  </div>
                )}
              </div>
            ) : (
              // ── Default lightbox footer ──
              <div className="flex items-center gap-4 px-5 py-3 rounded-xl flex-wrap"
                style={{ background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                <span className="text-xs text-white/70 flex-1 min-w-0 truncate">
                  {isAiPhoto(lightbox)
                    ? (lightbox.generation_prompt || 'AI Generated')
                    : (lightbox.file_name || 'Studio Photo')}
                </span>
                {lightbox.file_size && <span className="text-[10px] text-white/40 flex-shrink-0">{formatSize(lightbox.file_size)}</span>}
                <span
                  className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded flex-shrink-0"
                  style={{
                    background: isAiPhoto(lightbox) ? 'rgba(139,92,246,0.3)' : 'rgba(16,185,129,0.3)',
                    color: isAiPhoto(lightbox) ? '#c4b5fd' : '#6ee7b7',
                  }}
                >
                  {isAiPhoto(lightbox) ? 'AI' : 'Studio'}
                </span>
                <button
                  onClick={openReimagine}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all hover:-translate-y-0.5 flex-shrink-0"
                  style={{ background: 'var(--brand-primary)', color: '#fff' }}
                >
                  <Sparkles size={11} /> AI Reimagine
                </button>
                {isOwner && (
                  <button
                    onClick={() => { deletePhoto(lightbox); closeLightbox() }}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold text-red-400 hover:bg-red-500/20 transition-colors flex-shrink-0"
                  >
                    <Trash2 size={11} /> Delete
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Layout>
  )
}

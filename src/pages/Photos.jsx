import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import Layout from '../components/Layout'
import {
  Upload, Image as ImageIcon, Trash2, X, Check,
  AlertCircle, Loader2, Plus, Eye,
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

  const activity = photos.filter(p => p.keywords !== 'headshot')
  const headshots = photos.filter(p => p.keywords === 'headshot')
  const filtered = filter === 'all' ? photos : filter === 'activity' ? activity : headshots

  const formatSize = (bytes) => {
    if (!bytes) return ''
    if (bytes < 1024) return bytes + 'B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + 'KB'
    return (bytes / 1048576).toFixed(1) + 'MB'
  }

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

      {/* Stats bar */}
      {!loading && photos.length > 0 && (
        <div className="flex items-center gap-4 mb-6">
          {[
            { label: 'All', value: 'all', count: photos.length },
            { label: 'Activity', value: 'activity', count: activity.length },
            { label: 'Headshots', value: 'headshot', count: headshots.length },
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

          {/* Drop zone — always visible but compact */}
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
            <p className="text-sm text-slate-500">Drop photos here or click to browse</p>
            <span className="text-[10px] text-slate-700">JPG, PNG, WebP — max 25MB</span>
          </div>

          {/* Pending files */}
          {pendingFiles.length > 0 && (
            <div className="rounded-xl mb-6 overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="px-5 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span className="text-xs font-bold text-white uppercase tracking-wider">{pendingFiles.length} file{pendingFiles.length > 1 ? 's' : ''} ready</span>
              </div>
              <div className="p-4 space-y-1.5">
                {pendingFiles.map((f, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <span className="text-xs text-slate-300 truncate flex-1">{f.name}</span>
                    <span className="text-[10px] text-slate-600 mx-3">{formatSize(f.size)}</span>
                    <button onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))} className="text-slate-600 hover:text-red-400 transition-colors"><X size={12} /></button>
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
                  className="px-3 py-2 rounded-lg text-xs text-slate-500 hover:text-white transition-colors"
                  style={{ background: 'rgba(255,255,255,0.04)' }}
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Upload message */}
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
          <p className="text-slate-500 text-sm">Loading photos...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <ImageIcon size={48} className="mx-auto mb-4" style={{ color: 'rgba(255,255,255,0.1)' }} />
          <p className="text-white text-lg font-semibold mb-1">
            {photos.length === 0 ? 'No photos yet' : 'No photos in this category'}
          </p>
          <p className="text-slate-500 text-sm">
            {photos.length === 0 ? 'Upload studio photos to use in your content.' : 'Try a different filter.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {filtered.map(photo => {
            const isHeadshot = photo.keywords === 'headshot'
            const label = isHeadshot
              ? (photo.tags?.[0] || 'Headshot')
              : (photo.keywords || photo.file_name || 'Studio Photo')
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

                {/* Hover overlay */}
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

                {/* Category badge */}
                <span
                  className="absolute top-2 left-2 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider"
                  style={{
                    background: isHeadshot ? 'rgba(139,92,246,0.25)' : 'rgba(16,185,129,0.25)',
                    color: isHeadshot ? '#c4b5fd' : '#6ee7b7',
                    backdropFilter: 'blur(8px)',
                  }}
                >
                  {isHeadshot ? 'Headshot' : 'Activity'}
                </span>

                {/* Label */}
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
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.9)' }}
          onClick={() => setLightbox(null)}
        >
          <button
            className="absolute top-6 right-6 w-10 h-10 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 transition-colors"
            onClick={() => setLightbox(null)}
          >
            <X size={20} className="text-white" />
          </button>
          <img
            src={lightbox.photo_url}
            alt={lightbox.keywords || 'Photo'}
            className="max-w-full max-h-[85vh] rounded-xl object-contain"
            onClick={e => e.stopPropagation()}
          />
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 px-5 py-3 rounded-xl"
            style={{ background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(12px)' }}
            onClick={e => e.stopPropagation()}
          >
            <span className="text-xs text-white/70">{lightbox.file_name || 'Photo'}</span>
            {lightbox.file_size && <span className="text-[10px] text-white/40">{formatSize(lightbox.file_size)}</span>}
            <span className="text-[10px] text-white/40 uppercase">{lightbox.keywords || 'activity'}</span>
            {isOwner && (
              <button
                onClick={() => { deletePhoto(lightbox); setLightbox(null) }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold text-red-400 hover:bg-red-500/20 transition-colors"
              >
                <Trash2 size={11} /> Delete
              </button>
            )}
          </div>
        </div>
      )}
    </Layout>
  )
}

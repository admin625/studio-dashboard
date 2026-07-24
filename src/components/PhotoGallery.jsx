/**
 * PhotoGallery + Upload — Studio photo media library.
 * Owner-only upload with drag-and-drop. Photos stored in Supabase Storage + studio_photos table.
 */
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import {
  Upload, Image as ImageIcon, ChevronDown, ChevronUp,
  Loader2, X, Check, AlertCircle,
} from 'lucide-react'

export default function PhotoGallery() {
  const app = useApp()
  const primary = app.brandColorPrimary || '#667eea'
  const isOwner = app.authReady && app.role === 'studio_owner' // 2b — gate on authReady

  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [pendingFiles, setPendingFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState(null)
  const [category, setCategory] = useState('activity')
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    if (!app.resolvedStudioId) return
    let mounted = true
    supabase.from('studio_photos')
      .select('*')
      .eq('studio_id', app.resolvedStudioId)
      .eq('is_active', true)
      .then(({ data }) => {
        if (mounted && data) setPhotos(data)
        if (mounted) setLoading(false)
      })
    return () => { mounted = false }
  }, [app.resolvedStudioId])

  const handleFiles = (fileList) => {
    const TYPES = ['image/jpeg', 'image/png', 'image/webp']
    const MAX = 25 * 1024 * 1024
    const newFiles = []
    for (const f of fileList) {
      if (!TYPES.includes(f.type)) continue
      if (f.size > MAX) continue
      if (pendingFiles.some(x => x.name === f.name && x.size === f.size)) continue
      newFiles.push(f)
    }
    setPendingFiles(prev => [...prev, ...newFiles])
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
        await supabase.from('studio_photos').insert({
          photo_url: urlData.publicUrl,
          file_name: file.name,
          file_size: file.size,
          keywords: category,
          uploaded_by: app.email,
          is_active: true,
          studio_id: app.resolvedStudioId,
        })
        ok++
      } catch (e) { fail++ }
    }
    setPendingFiles([])
    setUploading(false)
    setUploadMsg(fail === 0 ? { type: 'success', text: `${ok} photo${ok > 1 ? 's' : ''} uploaded!` } : { type: 'error', text: `${ok} uploaded, ${fail} failed.` })
    setTimeout(() => setUploadMsg(null), 5000)
    // Refresh
    const { data } = await supabase.from('studio_photos').select('*').eq('studio_id', app.resolvedStudioId).eq('is_active', true)
    if (data) setPhotos(data)
  }

  const activity = photos.filter(p => p.keywords !== 'headshot')
  const headshots = photos.filter(p => p.keywords === 'headshot')

  return (
    <div className="mt-8">
      {/* Upload zone (owner only) */}
      {isOwner && (
        <div className="mb-6 rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div className="flex items-center gap-2">
              <Upload size={16} style={{ color: primary }} />
              <span className="text-sm font-bold text-white">Upload Studio Photos</span>
            </div>
          </div>
          <div className="p-5">
            <div
              className={`flex flex-col items-center justify-center gap-3 py-8 rounded-xl cursor-pointer transition-all ${dragOver ? 'scale-[1.01]' : ''}`}
              style={{ border: `1.5px dashed ${dragOver ? primary : 'rgba(255,255,255,0.1)'}`, background: dragOver ? `${primary}08` : 'transparent' }}
              onClick={() => fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
            >
              <ImageIcon size={24} style={{ color: 'rgba(255,255,255,0.2)' }} />
              <p className="text-sm text-slate-400">Drop photos here or click to browse</p>
              <p className="text-[10px] text-slate-500">JPG, PNG, WebP — max 25MB each</p>
            </div>
            <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e => { handleFiles(e.target.files); e.target.value = '' }} />

            {pendingFiles.length > 0 && (
              <div className="mt-4">
                <div className="space-y-1.5 mb-3">
                  {pendingFiles.map((f, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }}>
                      <span className="text-xs text-slate-300 truncate flex-1">{f.name}</span>
                      <span className="text-[10px] text-slate-500 mx-3">{(f.size / 1024).toFixed(0)}KB</span>
                      <button onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))} className="text-slate-500 hover:text-red-400"><X size={12} /></button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <select value={category} onChange={e => setCategory(e.target.value)}
                    className="px-3 py-2 rounded-lg text-xs text-white" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <option value="activity">Activity / Studio</option>
                    <option value="headshot">Instructor Headshot</option>
                  </select>
                  <button onClick={startUpload} disabled={uploading}
                    className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all hover:-translate-y-0.5 disabled:opacity-60"
                    style={{ background: primary, color: '#fff' }}>
                    {uploading ? 'Uploading...' : 'Upload'}
                  </button>
                </div>
              </div>
            )}

            {uploadMsg && (
              <div className={`mt-3 px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2`}
                style={{ background: uploadMsg.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: uploadMsg.type === 'success' ? '#10b981' : '#ef4444' }}>
                {uploadMsg.type === 'success' ? <Check size={12} /> : <AlertCircle size={12} />}
                {uploadMsg.text}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Gallery */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <button onClick={() => setExpanded(v => !v)} className="w-full flex items-center justify-between px-5 py-4 text-left">
          <div className="flex items-center gap-2">
            <ImageIcon size={16} style={{ color: primary }} />
            <span className="text-sm font-bold text-white">Studio Photos</span>
            {!loading && <span className="text-xs text-slate-400">{photos.length} photos</span>}
          </div>
          {expanded ? <ChevronUp size={16} className="text-slate-500" /> : <ChevronDown size={16} className="text-slate-500" />}
        </button>

        {expanded && (
          <div className="px-5 pb-5">
            {loading ? (
              <div className="py-8 text-center"><Loader2 size={20} className="animate-spin mx-auto" style={{ color: primary }} /></div>
            ) : photos.length === 0 ? (
              <p className="text-sm text-slate-400 py-4">No photos uploaded yet.</p>
            ) : (
              <div>
                {activity.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Studio & Activity ({activity.length})</p>
                    <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                      {activity.map(p => (
                        <div key={p.id} className="aspect-square rounded-lg overflow-hidden bg-white/5">
                          <img src={p.thumbnail_url || p.photo_url} alt={p.keywords || 'Studio'} className="w-full h-full object-cover" loading="lazy" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {headshots.length > 0 && (
                  <div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Instructor Headshots ({headshots.length})</p>
                    <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                      {headshots.map(p => (
                        <div key={p.id} className="aspect-square rounded-lg overflow-hidden bg-white/5">
                          <img src={p.thumbnail_url || p.photo_url} alt={p.tags?.[0] || 'Headshot'} className="w-full h-full object-cover" loading="lazy" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

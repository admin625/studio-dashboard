/**
 * PostCard — Single post within a delivery detail.
 * Caption, hashtags, photo, metadata, edit/copy/download actions.
 */
import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import {
  Copy, Check, Pencil, Download, Clock, Target,
  Image as ImageIcon, Sparkles,
} from 'lucide-react'

const PLATFORM_LABEL = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', all: 'All Platforms' }
const FORMAT_COLORS = {
  feed_post: { bg: '#dcfce7', color: '#166534' },
  story: { bg: '#fef3c7', color: '#92400e' },
  thread: { bg: '#f3e8ff', color: '#6b21a8' },
  carousel: { bg: '#fce7f3', color: '#9d174d' },
}

export default function PostCard({ post, index, platform, deliveryId, readOnly }) {
  const { brandColorPrimary } = useApp()
  const primary = brandColorPrimary || '#667eea'

  const [editing, setEditing] = useState(null) // 'caption' | 'hashtags' | null
  const [captionText, setCaptionText] = useState(post.caption || '')
  const [hashtagText, setHashtagText] = useState(post.hashtags || '')
  const [copied, setCopied] = useState(null) // 'caption' | 'hashtags' | null
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef(null)

  const isAI = post.needs_ai_image || (!post.matched_photo_id && post.photo_url)
  const hasImage = post.photo_url || post.needs_ai_image
  const fmtStyle = FORMAT_COLORS[post.format] || null

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
      // Read current content, update the specific post, write back
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
      {hasImage && post.photo_url && (
        <div className="relative">
          {post.image_platform && (
            <span
              className="absolute top-3 left-3 z-10 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
              style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', backdropFilter: 'blur(4px)' }}
            >
              {PLATFORM_LABEL[post.image_platform] || post.image_platform}
            </span>
          )}
          <img src={post.photo_url} alt="Post" className="w-full max-h-96 object-cover" />
          <div className="flex items-center gap-2 px-5 py-2" style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: isAI ? '#a78bfa' : '#10b981' }}>
              {isAI ? 'AI Generated' : 'Studio Photo'}
            </span>
            {post.image_direction && (
              <span className="text-[10px] text-slate-600 italic truncate">{post.image_direction}</span>
            )}
          </div>
        </div>
      )}

      {/* Metadata */}
      {(post.optimal_posting_time || post.engagement_goal) && (
        <div className="px-5 py-3 flex flex-wrap gap-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          {post.optimal_posting_time && (
            <div className="flex items-center gap-2">
              <Clock size={12} className="text-slate-600" />
              <span className="text-[11px] text-slate-500"><span className="font-semibold text-slate-400">Best Time:</span> {post.optimal_posting_time}</span>
            </div>
          )}
          {post.engagement_goal && (
            <div className="flex items-center gap-2">
              <Target size={12} className="text-slate-600" />
              <span className="text-[11px] text-slate-500"><span className="font-semibold text-slate-400">Goal:</span> {post.engagement_goal}</span>
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
              <p className="text-[10px] text-slate-600 mt-0.5">
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
        {post.photo_url && (
          <a href={post.photo_url} download target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:-translate-y-0.5"
            style={{ background: 'rgba(255,255,255,0.04)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.06)', textDecoration: 'none' }}>
            <Download size={12} /> Image
          </a>
        )}
      </div>
    </div>
  )
}

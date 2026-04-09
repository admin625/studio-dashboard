import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import { Loader2, Calendar, ChevronRight, Inbox, Sparkles } from 'lucide-react'

export default function DeliveryList({ onOpenGenerate, pollTrigger }) {
  const { resolvedStudioId, brandColorPrimary } = useApp()
  const [deliveries, setDeliveries] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [highlightIds, setHighlightIds] = useState(new Set())

  const primary = brandColorPrimary || '#667eea'

  const fetchDeliveries = async () => {
    try {
      // Try RPC first (returns counts), fallback to direct query
      let result = await supabase.rpc('get_delivery_summaries', {
        p_studio_id: resolvedStudioId || null
      })

      if (result.error) {
        console.warn('[DeliveryList] RPC failed, falling back:', result.error.message)
        let q = supabase.from('content_deliveries').select('id, created_at')
        if (resolvedStudioId) q = q.eq('studio_id', resolvedStudioId)
        result = await q.order('created_at', { ascending: false }).limit(50)
        if (result.data) {
          result.data = result.data.map(d => ({
            id: d.id, created_at: d.created_at,
            instagram_count: 0, facebook_count: 0, twitter_count: 0, linkedin_count: 0, tiktok_count: 0,
          }))
        }
      }

      if (result.error) throw result.error
      return result.data || []
    } catch (err) {
      throw err
    }
  }

  useEffect(() => {
    let mounted = true
    setLoading(true)
    fetchDeliveries()
      .then(data => { if (mounted) { setDeliveries(data); setLoading(false) } })
      .catch(err => { if (mounted) { setError(err.message); setLoading(false) } })
    return () => { mounted = false }
  }, [resolvedStudioId, pollTrigger]) // eslint-disable-line

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 size={32} className="animate-spin mb-4" style={{ color: primary }} />
        <p className="text-slate-500 text-sm">Loading your deliveries...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-sm mb-2">Error loading deliveries</p>
        <p className="text-slate-600 text-xs">{error}</p>
      </div>
    )
  }

  if (!deliveries || deliveries.length === 0) {
    return (
      <div className="text-center py-20">
        <Inbox size={48} className="mx-auto mb-4" style={{ color: 'rgba(255,255,255,0.1)' }} />
        <p className="text-white text-lg font-semibold mb-1">No content yet</p>
        <p className="text-slate-500 text-sm mb-6">Hit Create Content to generate your first post.</p>
        <button
          onClick={onOpenGenerate}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-all hover:-translate-y-0.5"
          style={{ background: primary, color: isLight(primary) ? '#0A0B0D' : '#fff' }}
        >
          <Sparkles size={16} /> Create Content
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="space-y-2">
        {deliveries.map(d => {
          const date = d.created_at
            ? new Date(d.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
            : 'Unknown date'

          const ig = d.instagram_count || 0
          const fb = d.facebook_count || 0
          const tw = d.twitter_count || 0
          const li = d.linkedin_count || 0
          const tk = d.tiktok_count || 0
          const total = ig + fb + tw + li + tk

          const platforms = []
          if (ig) platforms.push({ label: 'IG', count: ig, color: '#E1306C' })
          if (fb) platforms.push({ label: 'FB', count: fb, color: '#1877F2' })
          if (tw) platforms.push({ label: 'X', count: tw, color: '#1DA1F2' })
          if (li) platforms.push({ label: 'LI', count: li, color: '#0A66C2' })
          if (tk) platforms.push({ label: 'TT', count: tk, color: '#00f2ea' })

          const isNew = highlightIds.has(d.id)

          return (
            <Link
              key={d.id}
              to={`/delivery/${d.id}`}
              className="flex items-center justify-between px-5 py-4 rounded-xl transition-all duration-200 hover:-translate-y-0.5 group"
              style={{
                background: isNew ? `${primary}15` : 'rgba(255,255,255,0.03)',
                border: isNew ? `1px solid ${primary}40` : '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Calendar size={12} className="text-slate-600" />
                  <span className="text-xs text-slate-400 font-medium">{date}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {platforms.map(p => (
                    <span
                      key={p.label}
                      className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                      style={{ background: p.color + '20', color: p.color }}
                    >
                      {p.label} {p.count}
                    </span>
                  ))}
                  {platforms.length === 0 && (
                    <span className="text-xs text-slate-600">No content</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-slate-300">
                  {total} post{total !== 1 ? 's' : ''}
                </span>
                <ChevronRight size={16} className="text-slate-600 group-hover:text-white transition-colors" />
              </div>
            </Link>
          )
        })}
      </div>
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

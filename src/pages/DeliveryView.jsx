/**
 * DeliveryView — Full delivery detail page.
 * Loads delivery by ID, shows posts grouped by platform with tabs.
 */
import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useApp } from '../context/AppContext'
import Layout from '../components/Layout'
import PostCard from '../components/PostCard'
import { Loader2, ChevronLeft, Lock, Calendar } from 'lucide-react'

const PLATFORMS = ['instagram', 'facebook', 'twitter', 'linkedin', 'tiktok']
const PLATFORM_LABELS = { instagram: 'Instagram', facebook: 'Facebook', twitter: 'X (Twitter)', linkedin: 'LinkedIn', tiktok: 'TikTok' }
const PLATFORM_SHORT = { instagram: 'IG', facebook: 'FB', twitter: 'X', linkedin: 'LI', tiktok: 'TT' }

export default function DeliveryView() {
  const { id } = useParams()
  const app = useApp()
  const primary = app.brandColorPrimary || '#667eea'

  const [delivery, setDelivery] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState(null)

  const isOwner = app.role === 'studio_owner'
  const readOnly = !isOwner

  useEffect(() => {
    let mounted = true

    const loadDelivery = async () => {
      try {
        const { data, error: err } = await supabase
          .from('content_deliveries')
          .select('id, created_at, studio_id, client_id, instructor_email, instagram_content, facebook_content, twitter_content, linkedin_content, tiktok_content, video_url, video_status, video_render_id, video_error')
          .eq('id', id)
          .single()

        if (!mounted) return
        if (err) throw err

        // Verify ownership
        let belongs = false
        if (app.scopeType === 'studio' && data.studio_id === app.resolvedStudioId) belongs = true
        else if (app.scopeType === 'individual' && data.client_id === app.resolvedClientId) belongs = true

        if (!belongs) {
          setError('access_denied')
          setLoading(false)
          return
        }

        setDelivery(data)

        // Set first tab with content
        const firstPlatform = PLATFORMS.find(p => {
          const content = data[`${p}_content`]
          return content && content.length > 0
        })
        if (firstPlatform) setActiveTab(firstPlatform)

        setLoading(false)
      } catch (err) {
        if (mounted) { setError(err.message); setLoading(false) }
      }
    }

    loadDelivery()
    return () => { mounted = false }
  }, [id, app.scopeType, app.resolvedStudioId, app.resolvedClientId])

  if (loading) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin mb-4" style={{ color: primary }} />
          <p className="text-slate-400 text-sm">Loading content...</p>
        </div>
      </Layout>
    )
  }

  if (error === 'access_denied') {
    return (
      <Layout>
        <div className="text-center py-20">
          <Lock size={48} className="mx-auto mb-4" style={{ color: 'rgba(255,255,255,0.1)' }} />
          <p className="text-white text-lg font-semibold mb-1">Access Denied</p>
          <p className="text-slate-200 text-sm mb-6">This content does not belong to your account.</p>
          <Link to="/deliveries" className="text-sm font-semibold transition-colors" style={{ color: primary }}>
            Back to Deliveries
          </Link>
        </div>
      </Layout>
    )
  }

  if (error) {
    return (
      <Layout>
        <div className="text-center py-20">
          <p className="text-red-400 text-sm mb-2">Error loading content</p>
          <p className="text-slate-500 text-xs">{error}</p>
          <Link to="/deliveries" className="block mt-4 text-sm font-semibold" style={{ color: primary }}>Back to Deliveries</Link>
        </div>
      </Layout>
    )
  }

  if (!delivery) return null

  const date = delivery.created_at
    ? new Date(delivery.created_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : 'Unknown date'

  // Collect platforms with content
  const platformsWithContent = PLATFORMS.filter(p => {
    const content = delivery[`${p}_content`]
    return content && content.length > 0
  })

  const activePosts = activeTab ? (delivery[`${activeTab}_content`] || []) : []

  return (
    <Layout>
      {/* Back nav */}
      <Link to="/deliveries" className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-400 hover:text-white transition-colors mb-6">
        <ChevronLeft size={16} /> All Deliveries
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-6 h-px" style={{ background: primary }} />
          <span className="text-[10px] font-semibold tracking-[0.2em] uppercase" style={{ color: primary }}>Delivery Detail</span>
        </div>
        <div className="flex items-center gap-3">
          <Calendar size={16} className="text-slate-500" />
          <h1 className="text-white text-xl font-bold" style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: '0.02em' }}>{date}</h1>
        </div>
        {readOnly && (
          <p className="text-xs text-slate-500 mt-2 flex items-center gap-1.5">
            <Lock size={10} /> Read-only — instructors cannot edit content
          </p>
        )}
      </div>

      {/* Platform tabs */}
      {platformsWithContent.length > 1 && (
        <div className="flex gap-1.5 mb-6 overflow-x-auto pb-1">
          {platformsWithContent.map(p => {
            const active = activeTab === p
            const count = (delivery[`${p}_content`] || []).length
            return (
              <button
                key={p}
                onClick={() => setActiveTab(p)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap"
                style={{
                  background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
                  color: active ? '#fff' : '#94a3b8',
                  border: `1px solid ${active ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)'}`,
                }}
              >
                <span style={{ color: active ? primary : '#94a3b8' }}>{PLATFORM_SHORT[p]}</span>
                {PLATFORM_LABELS[p]} ({count})
              </button>
            )
          })}
        </div>
      )}

      {/* Posts */}
      {activePosts.length > 0 ? (
        <div>
          {activePosts.map((post, idx) => (
            <PostCard
              key={`${activeTab}-${idx}`}
              post={post}
              index={idx}
              platform={activeTab}
              deliveryId={id}
              readOnly={readOnly}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-slate-400 text-sm">No content on this platform.</p>
        </div>
      )}

      {/* Video section placeholder */}
      {delivery.video_url && delivery.video_status === 'succeeded' && (
        <div className="mt-6 rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="px-5 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <span className="text-xs font-bold text-slate-400">Video Reel</span>
          </div>
          <div className="p-4">
            <video src={delivery.video_url} controls className="w-full max-h-96 rounded-lg" />
          </div>
        </div>
      )}
    </Layout>
  )
}

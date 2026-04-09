import { useState, useEffect, useRef, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { supabase } from '../lib/supabase'
import Layout from '../components/Layout'
import DeliveryList from '../components/DeliveryList'
import GenerateModal from '../components/GenerateModal'
import PhotoGallery from '../components/PhotoGallery'
import { Plus, Sparkles, X } from 'lucide-react'

const POLL_INTERVAL = 15000

export default function Dashboard() {
  const app = useApp()
  const primary = app.brandColorPrimary || '#667eea'

  const [genOpen, setGenOpen] = useState(false)
  const [showBanner, setShowBanner] = useState(false)
  const [pollTrigger, setPollTrigger] = useState(0)
  const [pendingPlatforms, setPendingPlatforms] = useState(null)
  const [pendingTime, setPendingTime] = useState(null)
  const pollRef = useRef(null)
  const knownIdsRef = useRef(new Set())

  // Capture known delivery IDs on mount
  useEffect(() => {
    if (!app.resolvedStudioId) return
    supabase.rpc('get_delivery_summaries', { p_studio_id: app.resolvedStudioId })
      .then(({ data }) => {
        if (data) knownIdsRef.current = new Set(data.map(d => d.id))
      })
  }, [app.resolvedStudioId])

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await supabase.rpc('get_delivery_summaries', { p_studio_id: app.resolvedStudioId })
        if (!data) return
        const newIds = data.filter(d => !knownIdsRef.current.has(d.id))
        if (newIds.length > 0) {
          // New delivery found — stop polling, update list
          clearInterval(pollRef.current)
          pollRef.current = null
          newIds.forEach(d => knownIdsRef.current.add(d.id))
          setPendingPlatforms(null)
          setPendingTime(null)
          setShowBanner(false)
          setPollTrigger(t => t + 1)
        }
      } catch (e) { /* silent */ }
    }, POLL_INTERVAL)
  }, [app.resolvedStudioId])

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const handleGenSubmitted = (platforms) => {
    setShowBanner(true)
    setPendingPlatforms(platforms || ['instagram'])
    setPendingTime(new Date())
    startPolling()
  }

  return (
    <Layout>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-6 h-px" style={{ background: primary }} />
            <span className="text-[10px] font-semibold tracking-[0.2em] uppercase" style={{ color: primary }}>Content</span>
          </div>
          <h1 className="text-white" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 'clamp(1.8rem, 4vw, 2.6rem)', letterSpacing: '0.02em' }}>
            Your Deliveries
          </h1>
        </div>
        <button
          onClick={() => setGenOpen(true)}
          className="flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-bold transition-all hover:-translate-y-0.5"
          style={{ background: primary, color: isLight(primary) ? '#0A0B0D' : '#fff', boxShadow: `0 4px 20px ${primary}40` }}
        >
          <Plus size={16} />
          <span className="hidden sm:inline">Create Content</span>
          <span className="sm:hidden">Create</span>
        </button>
      </div>

      {/* Async generation banner */}
      {showBanner && (
        <div
          className="flex items-center gap-3 px-5 py-4 rounded-xl mb-5 relative overflow-hidden"
          style={{ background: `${primary}12`, border: `1px solid ${primary}30` }}
        >
          {/* Animated pulse bar */}
          <div className="absolute inset-0 opacity-20" style={{
            background: `linear-gradient(90deg, transparent, ${primary}40, transparent)`,
            animation: 'pulse-slide 2.5s ease-in-out infinite',
          }} />
          <div className="relative z-10 flex items-center gap-3 flex-1">
            <Sparkles size={18} style={{ color: primary }} className="flex-shrink-0" />
            <div>
              <p className="text-sm text-white font-semibold">Your content is being created</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Ready within 20 minutes. We'll email you as soon as it's done.
              </p>
            </div>
          </div>
          <button onClick={() => setShowBanner(false)} className="relative z-10 text-slate-500 hover:text-white transition-colors"><X size={16} /></button>
        </div>
      )}

      {/* Pending delivery card */}
      {pendingPlatforms && (
        <div
          className="rounded-xl mb-3 overflow-hidden"
          style={{ border: `1px solid ${primary}25` }}
        >
          <div className="relative px-5 py-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
            {/* Animated gradient shimmer */}
            <div className="absolute inset-0" style={{
              background: `linear-gradient(90deg, transparent, ${primary}08, transparent)`,
              animation: 'pulse-slide 3s ease-in-out infinite',
            }} />
            <div className="relative z-10 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Sparkles size={12} style={{ color: primary }} className="animate-pulse" />
                  <span className="text-xs text-slate-400">
                    {pendingTime ? new Date(pendingTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'Now'}
                  </span>
                </div>
                <p className="text-sm text-slate-300 font-medium">Generating your content...</p>
                <div className="flex gap-1.5 mt-1.5">
                  {pendingPlatforms.map(p => (
                    <span key={p} className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider" style={{ background: `${primary}20`, color: primary }}>
                      {p === 'twitter' ? 'X' : p.substring(0, 2).toUpperCase()}
                    </span>
                  ))}
                </div>
              </div>
              <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: `${primary}40`, borderTopColor: 'transparent' }} />
            </div>
          </div>
        </div>
      )}

      {/* Delivery list */}
      <DeliveryList onOpenGenerate={() => setGenOpen(true)} pollTrigger={pollTrigger} />

      {/* Photo gallery + upload */}
      <PhotoGallery />

      {/* Generate modal */}
      <GenerateModal open={genOpen} onClose={() => setGenOpen(false)} onSubmitted={handleGenSubmitted} />

      <style>{`
        @keyframes pulse-slide {
          0%, 100% { transform: translateX(-100%); }
          50% { transform: translateX(100%); }
        }
      `}</style>
    </Layout>
  )
}

function isLight(hex = '#000') {
  hex = hex.replace('#', '')
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2]
  if (hex.length !== 6) return false
  const r = parseInt(hex.substr(0,2),16), g = parseInt(hex.substr(2,2),16), b = parseInt(hex.substr(4,2),16)
  return (r*299 + g*587 + b*114)/1000 > 155
}

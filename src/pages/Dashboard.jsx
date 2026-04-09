import { useState, useEffect, useRef } from 'react'
import { useApp } from '../context/AppContext'
import Layout from '../components/Layout'
import DeliveryList from '../components/DeliveryList'
import GenerateModal from '../components/GenerateModal'
import PhotoGallery from '../components/PhotoGallery'
import { Plus, Loader2 } from 'lucide-react'

const POLL_INTERVAL = 30000
const POLL_TIMEOUT = 300000

export default function Dashboard() {
  const app = useApp()
  const primary = app.brandColorPrimary || '#667eea'

  const [genOpen, setGenOpen] = useState(false)
  const [banner, setBanner] = useState(null) // null | { type, msg }
  const [pollTrigger, setPollTrigger] = useState(0)
  const pollRef = useRef(null)
  const pollStartRef = useRef(0)

  const startPolling = () => {
    stopPolling()
    pollStartRef.current = Date.now()
    setBanner({ type: 'progress', msg: 'Your content is being crafted — expect it in 3–5 minutes...' })

    pollRef.current = setInterval(() => {
      const elapsed = Date.now() - pollStartRef.current
      if (elapsed >= POLL_TIMEOUT) {
        stopPolling()
        setBanner({ type: 'timeout', msg: 'Taking longer than usual — you will receive an email when ready.' })
        return
      }
      // Trigger a re-fetch of deliveries
      setPollTrigger(t => t + 1)
    }, POLL_INTERVAL)
  }

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  useEffect(() => {
    return () => stopPolling()
  }, [])

  const handleGenSubmitted = () => {
    startPolling()
  }

  return (
    <Layout>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-6 h-px" style={{ background: primary }} />
            <span className="text-[10px] font-semibold tracking-[0.2em] uppercase" style={{ color: primary }}>
              Content
            </span>
          </div>
          <h1
            className="text-white"
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: 'clamp(1.8rem, 4vw, 2.6rem)',
              letterSpacing: '0.02em',
            }}
          >
            Your Deliveries
          </h1>
        </div>
        <button
          onClick={() => setGenOpen(true)}
          className="flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-bold uppercase tracking-wider transition-all hover:-translate-y-0.5"
          style={{
            background: primary,
            color: isLight(primary) ? '#0A0B0D' : '#fff',
            boxShadow: `0 4px 20px ${primary}40`,
          }}
        >
          <Plus size={16} />
          Generate
        </button>
      </div>

      {/* Progress banner */}
      {banner && (
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-xl mb-4"
          style={{
            background: banner.type === 'progress' ? `${primary}15` :
              banner.type === 'success' ? 'rgba(16,185,129,0.15)' : 'rgba(234,179,8,0.15)',
            border: `1px solid ${banner.type === 'progress' ? primary + '40' :
              banner.type === 'success' ? '#10b98140' : '#eab30840'}`,
          }}
        >
          {banner.type === 'progress' && <Loader2 size={14} className="animate-spin" style={{ color: primary }} />}
          <span className="text-sm text-slate-300 flex-1">{banner.msg}</span>
          <button onClick={() => { setBanner(null); stopPolling() }} className="text-slate-500 hover:text-white text-xs">×</button>
        </div>
      )}

      {/* Delivery list */}
      <DeliveryList onOpenGenerate={() => setGenOpen(true)} pollTrigger={pollTrigger} />

      {/* Photo gallery + upload */}
      <PhotoGallery />

      {/* Generate modal */}
      <GenerateModal open={genOpen} onClose={() => setGenOpen(false)} onSubmitted={handleGenSubmitted} />
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

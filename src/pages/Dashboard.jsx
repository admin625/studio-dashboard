import { useApp } from '../context/AppContext'
import Layout from '../components/Layout'

export default function Dashboard() {
  const {
    role, resolvedStudioId, studioName, isBeta,
    brandColorPrimary, brandVoice, studioType, email
  } = useApp()

  const primary = brandColorPrimary || '#667eea'

  return (
    <Layout>
      {/* Dashboard hero — placeholder for Phase 3 (Brand Settings) + Phase 4 (Delivery List) */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-6 h-px" style={{ background: primary }} />
          <span
            className="text-[10px] font-semibold tracking-[0.2em] uppercase"
            style={{ color: primary }}
          >
            Dashboard
          </span>
        </div>
        <h1
          className="text-white mb-2"
          style={{
            fontFamily: "'Bebas Neue', sans-serif",
            fontSize: 'clamp(2rem, 5vw, 3rem)',
            letterSpacing: '0.02em',
          }}
        >
          Welcome back{studioName ? `, ${studioName}` : ''}.
        </h1>
        <p className="text-slate-500 text-sm">Phase 2 complete — auth + routing working.</p>
      </div>

      {/* Debug panel — shows auth state, removed in Phase 3+ */}
      <div
        className="rounded-xl p-6 mb-6"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <p className="text-xs font-bold tracking-widest uppercase text-slate-500 mb-4">Auth State</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            ['Email', email],
            ['Role', role],
            ['Studio ID', resolvedStudioId || '—'],
            ['Studio Name', studioName || '—'],
            ['Studio Type', studioType || '—'],
            ['is_beta', String(isBeta)],
            ['Brand Color', brandColorPrimary || '—'],
            ['Brand Voice', brandVoice ? brandVoice.substring(0, 50) + '…' : '—'],
          ].map(([label, val]) => (
            <div key={label} className="flex flex-col">
              <span className="text-[10px] font-semibold tracking-wider uppercase text-slate-600">{label}</span>
              <span className="text-slate-300 font-mono text-xs mt-0.5 break-all">{val}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Phase placeholder cards */}
      <div className="grid sm:grid-cols-2 gap-4">
        {[
          { phase: 3, label: 'Brand Settings', desc: 'Magazine Spread component', done: false },
          { phase: 4, label: 'Delivery List', desc: 'Content generation + list', done: false },
          { phase: 5, label: 'Delivery Detail', desc: 'Post cards + photo editor', done: false },
          { phase: 6, label: 'Gallery + Upload', desc: 'Photo management', done: false },
        ].map(p => (
          <div
            key={p.phase}
            className="rounded-xl p-5"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <span className="text-[10px] font-bold tracking-widest uppercase text-slate-600">
              Phase {p.phase}
            </span>
            <p className="text-white font-semibold mt-1">{p.label}</p>
            <p className="text-slate-500 text-xs mt-0.5">{p.desc}</p>
            <span
              className="inline-block mt-3 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
              style={{ background: p.done ? '#05966920' : '#64748b20', color: p.done ? '#10b981' : '#64748b' }}
            >
              {p.done ? 'Complete' : 'Pending'}
            </span>
          </div>
        ))}
      </div>
    </Layout>
  )
}

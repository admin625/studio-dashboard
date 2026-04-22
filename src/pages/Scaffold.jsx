import { useApp } from '../context/AppContext'

export default function Scaffold() {
  const { authReady } = useApp()

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-lg w-full text-center">
        {/* Hero mark */}
        <div
          className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-8"
          style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}
        >
          <span className="text-white text-2xl font-bold font-display">F</span>
        </div>

        <h1
          className="text-white mb-3 leading-none"
          style={{
            fontFamily: "'Bebas Neue', sans-serif",
            fontSize: 'clamp(2.5rem, 6vw, 4rem)',
            letterSpacing: '0.03em',
          }}
        >
          FCA Studio Dashboard
        </h1>

        <p className="text-slate-300 text-sm leading-relaxed mb-8 max-w-sm mx-auto">
          React + Vite + Tailwind migration in progress.
          <br />
          Phase 1 scaffold deployed successfully.
        </p>

        {/* Status cards */}
        <div className="grid grid-cols-2 gap-3 text-left mb-8">
          {[
            { label: 'React 19', ok: true },
            { label: 'Vite', ok: true },
            { label: 'Tailwind CSS', ok: true },
            { label: 'Supabase SDK', ok: true },
            { label: 'React Router', ok: true },
            { label: 'Lucide Icons', ok: true },
            { label: 'Google Fonts', ok: true },
            { label: 'Netlify Deploy', ok: true },
          ].map(item => (
            <div
              key={item.label}
              className="flex items-center gap-2.5 px-4 py-3 rounded-lg"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: item.ok ? '#10b981' : '#ef4444' }}
              />
              <span className="text-xs font-medium text-slate-300">{item.label}</span>
            </div>
          ))}
        </div>

        <p className="text-xs text-slate-500">
          v2.0.0 &middot; Phase 1 Complete &middot; Auth + routing coming in Phase 2
        </p>
      </div>
    </div>
  )
}

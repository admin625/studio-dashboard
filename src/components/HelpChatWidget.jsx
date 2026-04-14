import { useState, useRef, useEffect } from 'react'

const WEBHOOK_URL = 'https://jmac.app.n8n.cloud/webhook/fca-help-chat'

const SUGGESTIONS = [
  'Writing prompts',
  'Brand settings',
  'AI photos',
  'Adding instructors',
]

export default function HelpChatWidget({ currentPage }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Build history array for Claude (alternating user/assistant)
  function getHistory() {
    return messages.map((m) => ({ role: m.role, content: m.text }))
  }

  async function send(text) {
    if (!text.trim() || loading) return
    const userMsg = { role: 'user', text: text.trim() }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg.text,
          history: getHistory(),
          currentPage: currentPage || 'unknown',
        }),
      })
      const data = await res.json()
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: data.reply || 'No response received.' },
      ])
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: 'Could not reach the help assistant. Please try again.' },
      ])
    }
    setLoading(false)
  }

  function handleSubmit(e) {
    e.preventDefault()
    send(input)
  }

  return (
    <>
      {/* Chat panel */}
      {open && (
        <div
          style={{
            position: 'fixed',
            bottom: 80,
            right: 24,
            width: 360,
            height: 460,
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
            border: '1px solid rgba(255,255,255,0.08)',
            background: '#111214',
            fontFamily: "'Inter', -apple-system, sans-serif",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '14px 16px',
              background: '#0A0B0D',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ color: '#fff', fontWeight: 600, fontSize: 14 }}>
              FCA Studio Help
            </span>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(255,255,255,0.4)',
                cursor: 'pointer',
                fontSize: 18,
                lineHeight: 1,
                padding: 4,
              }}
            >
              ×
            </button>
          </div>

          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {messages.length === 0 && !loading && (
              <div style={{ textAlign: 'center', paddingTop: 24 }}>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginBottom: 16 }}>
                  How can I help you with FCA Studio?
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 20,
                        color: 'rgba(255,255,255,0.7)',
                        padding: '6px 14px',
                        fontSize: 12,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.background = 'rgba(255,255,255,0.1)'
                        e.target.style.color = '#fff'
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.background = 'rgba(255,255,255,0.06)'
                        e.target.style.color = 'rgba(255,255,255,0.7)'
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                }}
              >
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                    background: m.role === 'user' ? '#2563eb' : 'rgba(255,255,255,0.07)',
                    color: m.role === 'user' ? '#fff' : 'rgba(255,255,255,0.85)',
                    fontSize: 13,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {m.text}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ alignSelf: 'flex-start', maxWidth: '85%' }}>
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: '14px 14px 14px 4px',
                    background: 'rgba(255,255,255,0.07)',
                    color: 'rgba(255,255,255,0.4)',
                    fontSize: 13,
                    display: 'flex',
                    gap: 4,
                  }}
                >
                  <span style={{ animation: 'pulse 1.2s infinite' }}>●</span>
                  <span style={{ animation: 'pulse 1.2s infinite 0.2s' }}>●</span>
                  <span style={{ animation: 'pulse 1.2s infinite 0.4s' }}>●</span>
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={handleSubmit}
            style={{
              padding: '12px 16px',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              gap: 8,
              background: '#0A0B0D',
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question..."
              disabled={loading}
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                padding: '8px 12px',
                color: '#fff',
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              style={{
                background: loading || !input.trim() ? 'rgba(255,255,255,0.05)' : '#2563eb',
                border: 'none',
                borderRadius: 8,
                padding: '8px 14px',
                color: loading || !input.trim() ? 'rgba(255,255,255,0.3)' : '#fff',
                fontSize: 13,
                fontWeight: 600,
                cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                transition: 'all 0.15s',
              }}
            >
              Send
            </button>
          </form>
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          width: 48,
          height: 48,
          borderRadius: '50%',
          background: '#0A0B0D',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          cursor: 'pointer',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'transform 0.15s, box-shadow 0.15s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'scale(1.08)'
          e.currentTarget.style.boxShadow = '0 6px 20px rgba(0,0,0,0.5)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)'
          e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)'
        }}
        title="Help"
      >
        {open ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        )}
      </button>

      {/* Typing indicator keyframes */}
      <style>{`
        @keyframes pulse {
          0%, 80%, 100% { opacity: 0.3; }
          40% { opacity: 1; }
        }
      `}</style>
    </>
  )
}

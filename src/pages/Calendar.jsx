/**
 * Calendar — owner week view, slot view, and read-only quarter view (2d, first cut).
 *
 * WHAT THIS CUT DOES: the week's slots for the signed-in studio (day, job in Katie's words,
 * one-line reason, status), a slot panel with an editable reason and three actions, and a
 * read-only 13-week quarter view with three percentages under each bar.
 *
 * WHAT IT DOES NOT DO, BY THE WO: mix sliders, re-point a week, event campaign cadence, event
 * date entry, instructor seats, planner re-run. Do not add them here quietly.
 *
 * THE WEEK IT LANDS ON. HQ ruling 2026-09-17: land on the first week carrying slots on or after
 * today and say so in the header, rather than re-dating any data. TLK's Q4 begins 2026-10-05, so
 * before October this legitimately shows a future week — an empty "this week" is the true state
 * of the plan, and the header is what stops that reading as a bug.
 *
 * GATING. Reads wait on `studioLoaded`, never on `authReady`. authReady is only a proxy: the 10s
 * safety valve sets it alone, with no studio resolved, so a read gated on it can fire with a null
 * studio id and return nothing that looks like an error.
 */
import { useState, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { getSessionOnce } from '../lib/supabase'
import Layout from '../components/Layout'
import GenerateModal from '../components/GenerateModal'
import {
  Calendar as CalendarIcon, ChevronLeft, ChevronRight, Lock,
  Check, SkipForward, PenLine, Loader2, X,
} from 'lucide-react'

const ENDPOINT = '/.netlify/functions/calendar'

const JOB_COLOR = {
  awareness: '#60a5fa',
  class_traffic: '#34d399',
  event_conversion: '#f59e0b',
}
const JOB_ORDER = ['awareness', 'class_traffic', 'event_conversion']
const JOB_LABEL = {
  awareness: 'Getting to know us',
  class_traffic: 'Into class',
  event_conversion: 'Events',
}

function fmtDay(ymd) {
  if (!ymd) return ''
  // Parse as UTC — slot_date is a `date`, and `new Date('2026-10-05')` is already UTC-midnight.
  // Formatting it in local time would shift it a day west of Greenwich.
  return new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  })
}

function fmtWeek(ymd) {
  if (!ymd) return ''
  return new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

export default function Calendar() {
  const app = useApp()
  const primary = app.brandColorPrimary || '#667eea'

  const [view, setView] = useState('week')
  const [weekData, setWeekData] = useState(null)
  const [quarterData, setQuarterData] = useState(null)
  const [weekStart, setWeekStart] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openSlot, setOpenSlot] = useState(null)
  const [genSlot, setGenSlot] = useState(null)

  const call = useCallback(async (payload) => {
    const { data: { session } } = await getSessionOnce()
    if (!session?.access_token) throw new Error('SESSION')
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ studio_id: app.resolvedStudioId, ...payload }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
    return body
  }, [app.resolvedStudioId])

  const loadWeek = useCallback(async (ws) => {
    setLoading(true); setError('')
    try {
      const d = await call({ action: 'week', week_start: ws || undefined })
      setWeekData(d)
      if (!d.empty) setWeekStart(d.week.week_start)
    } catch (e) {
      setError(e.message === 'SESSION'
        ? 'Your session has expired. Reload the page and sign in again.'
        : "We couldn't load your calendar. Please try again.")
    } finally { setLoading(false) }
  }, [call])

  const loadQuarter = useCallback(async () => {
    setLoading(true); setError('')
    try { setQuarterData(await call({ action: 'quarter' })) }
    catch { setError("We couldn't load your quarter.") }
    finally { setLoading(false) }
  }, [call])

  // studioLoaded, not authReady — see the header note.
  useEffect(() => {
    if (!app.studioLoaded || !app.resolvedStudioId) return
    if (view === 'week') loadWeek(weekStart)
    else loadQuarter()
    // weekStart is driven by the nav buttons, which call loadWeek directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.studioLoaded, app.resolvedStudioId, view])

  if (app.studioLoadError) {
    return (
      <Layout>
        <Empty title="We couldn't load your studio"
          body="Reload the page and try again. If it keeps happening, contact support." />
      </Layout>
    )
  }

  return (
    <Layout>
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-6 h-px" style={{ background: primary }} />
            <span className="text-[10px] font-semibold tracking-[0.2em] uppercase" style={{ color: primary }}>
              Plan
            </span>
          </div>
          <h1 className="text-white" style={{
            fontFamily: "'Bebas Neue', sans-serif",
            fontSize: 'clamp(1.8rem, 4vw, 2.6rem)', letterSpacing: '0.02em',
          }}>
            Your Content Plan
          </h1>
        </div>
        <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          {['week', 'quarter'].map(v => (
            <button key={v} onClick={() => setView(v)}
              className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors"
              style={{
                background: view === v ? 'rgba(255,255,255,0.07)' : 'transparent',
                color: view === v ? '#fff' : '#4a5568',
              }}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg mb-4 text-sm"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5' }}>
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-10 justify-center">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      )}

      {!loading && view === 'week' && weekData && (
        weekData.empty
          ? <Empty title="No plan yet"
              body="Your quarter hasn't been planned yet. Once it is, your weeks show up here." />
          : <WeekView
              data={weekData}
              primary={primary}
              onNav={(ws) => { setWeekStart(ws); loadWeek(ws) }}
              onOpen={setOpenSlot}
            />
      )}

      {!loading && view === 'quarter' && quarterData && (
        quarterData.empty
          ? <Empty title="No plan yet" body="Your quarter hasn't been planned yet." />
          : <QuarterView data={quarterData} />
      )}

      {openSlot && (
        <SlotPanel
          slot={openSlot}
          primary={primary}
          onClose={() => setOpenSlot(null)}
          onAct={async (value) => {
            await call({ action: 'act', slot_id: openSlot.id, value })
            setOpenSlot(null)
            loadWeek(weekStart)
          }}
          onReason={async (text) => {
            await call({ action: 'reason', slot_id: openSlot.id, rationale: text })
            setOpenSlot(null)
            loadWeek(weekStart)
          }}
          onGenerate={async () => {
            // Record intent BEFORE opening the modal: the owner asking is the signal, and it
            // stays true whether or not the generation itself later succeeds.
            await call({ action: 'act', slot_id: openSlot.id, value: 'generate_requested' })
            setGenSlot(openSlot)
            setOpenSlot(null)
          }}
        />
      )}

      <GenerateModal
        open={!!genSlot}
        slotId={genSlot ? genSlot.id : null}
        slotJobLabel={genSlot ? genSlot.job_label : null}
        onClose={() => setGenSlot(null)}
        onSubmitted={() => { setGenSlot(null); loadWeek(weekStart) }}
      />
    </Layout>
  )
}

function WeekView({ data, primary, onNav, onOpen }) {
  const { week, slots, prev_week_start, next_week_start, quarter } = data
  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <button
          disabled={!prev_week_start}
          onClick={() => onNav(prev_week_start)}
          className="p-2 rounded-lg disabled:opacity-25 transition-colors hover:bg-white/5"
          aria-label="Previous week"
        ><ChevronLeft size={18} className="text-slate-300" /></button>

        <div className="text-center">
          <p className="text-white text-sm font-semibold">Week of {fmtWeek(week.week_start)}</p>
          {week.starts_later && (
            // The honest version of an empty "this week". The plan really does start later;
            // saying so is what stops a correct empty state reading as a broken screen.
            <p className="text-[11px] mt-0.5" style={{ color: primary }}>
              Your quarter starts {fmtWeek(week.week_start)}.
            </p>
          )}
        </div>

        <button
          disabled={!next_week_start}
          onClick={() => onNav(next_week_start)}
          className="p-2 rounded-lg disabled:opacity-25 transition-colors hover:bg-white/5"
          aria-label="Next week"
        ><ChevronRight size={18} className="text-slate-300" /></button>
      </div>

      {quarter && quarter.status === 'draft' && (
        <p className="text-[11px] text-slate-500 mb-4 text-center">
          This plan is still a draft.
        </p>
      )}

      {!slots.length && <Empty title="Nothing planned this week" body="Use the arrows to look at another week." />}

      <div className="space-y-2">
        {slots.map(s => (
          <button
            key={s.id}
            onClick={() => !s.held && onOpen(s)}
            disabled={s.held}
            className="w-full text-left rounded-xl px-4 py-3 transition-all"
            style={{
              background: s.held ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.06)',
              opacity: s.held ? 0.55 : 1,
              cursor: s.held ? 'default' : 'pointer',
            }}
          >
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-[11px] text-slate-400">{fmtDay(s.slot_date)}</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                style={{ background: (JOB_COLOR[s.job] || '#64748b') + '22', color: JOB_COLOR[s.job] || '#94a3b8' }}>
                {s.job_label}
              </span>
              {s.accepted && <Chip text="You said this is right" color="#34d399" />}
              {s.skipped && <Chip text="Skipped" color="#64748b" />}
              {s.status === 'generated' && <Chip text="Written" color={primary} />}
              {s.reason_source === 'owner' && <Chip text="Your words" color="#a78bfa" />}
            </div>
            <p className="text-sm text-slate-200 leading-snug">{s.reason}</p>
            {s.held && (
              <p className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-1.5">
                <Lock size={11} /> opens when you confirm
              </p>
            )}
          </button>
        ))}
      </div>
    </>
  )
}

function QuarterView({ data }) {
  return (
    <div className="space-y-3">
      {data.quarter.arc_text && (
        <p className="text-sm text-slate-300 leading-relaxed mb-5 px-1">{data.quarter.arc_text}</p>
      )}
      {data.weeks.map(w => (
        <div key={w.week_start} className="rounded-xl px-4 py-3"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <span className="text-[11px] text-slate-300 font-semibold">{fmtWeek(w.week_start)}</span>
            {w.event_title && <span className="text-[11px] text-amber-300/90">{w.event_title}</span>}
          </div>

          <div className="flex h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
            {JOB_ORDER.map(j => (
              w.pct[j] > 0 && (
                <div key={j} style={{ width: `${w.pct[j]}%`, background: JOB_COLOR[j] }} title={JOB_LABEL[j]} />
              )
            ))}
          </div>

          {/* The three percentages, printed — not only encoded in bar widths. */}
          <div className="flex gap-4 mt-2 flex-wrap">
            {JOB_ORDER.map(j => (
              <span key={j} className="text-[10px]" style={{ color: JOB_COLOR[j] }}>
                {JOB_LABEL[j]} {w.pct[j]}%
              </span>
            ))}
            {w.held > 0 && <span className="text-[10px] text-slate-500">{w.held} held</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function SlotPanel({ slot, primary, onClose, onAct, onReason, onGenerate }) {
  const [text, setText] = useState(slot.reason || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const run = async (fn) => {
    setBusy(true); setErr('')
    try { await fn() } catch (e) { setErr(e.message || 'That did not save.'); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-5 max-h-[90vh] overflow-y-auto"
        style={{ background: '#111318', border: '1px solid rgba(255,255,255,0.08)' }}>

        <div className="flex items-start justify-between mb-4 gap-3">
          <div>
            <p className="text-[11px] text-slate-400">{fmtDay(slot.slot_date)}</p>
            <p className="text-white text-lg" style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: '0.02em' }}>
              {slot.job_label}
            </p>
            {/* Job is read-only this cut — say so rather than showing a dead control. */}
            <p className="text-[10px] text-slate-500 mt-0.5">Set by your plan</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white p-1"><X size={18} /></button>
        </div>

        <label className="block text-[11px] text-slate-400 mb-1.5">Why this post</label>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={3}
          className="w-full rounded-lg px-3 py-2 text-sm text-slate-100 mb-1"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
        />
        <p className="text-[10px] text-slate-500 mb-4">
          {slot.reason_source === 'owner'
            ? 'This is your wording. Your plan\'s original reason is kept.'
            : 'From your plan. Editing keeps the original.'}
        </p>

        {slot.post_id && (
          <p className="text-[11px] mb-4" style={{ color: primary }}>A post has been written for this slot.</p>
        )}

        {err && <p className="text-[11px] text-red-300 mb-3">{err}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Action icon={PenLine} label="Write the post" disabled={busy}
            onClick={() => run(onGenerate)} bg={primary} solid />
          <Action icon={Check} label="That reason's right" disabled={busy}
            onClick={() => run(() => (text.trim() && text.trim() !== (slot.reason || '').trim())
              ? onReason(text.trim())
              : onAct('accepted'))} />
          <Action icon={SkipForward} label="Skip this one" disabled={busy}
            onClick={() => run(() => onAct('skipped'))} />
        </div>
      </div>
    </div>
  )
}

function Action({ icon: Icon, label, onClick, disabled, bg, solid }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-[11px] font-semibold transition-all disabled:opacity-40"
      style={solid
        ? { background: bg, color: '#0A0B0D' }
        : { background: 'rgba(255,255,255,0.05)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.08)' }}>
      <Icon size={13} /> {label}
    </button>
  )
}

function Chip({ text, color }) {
  return (
    <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider"
      style={{ background: color + '22', color }}>{text}</span>
  )
}

function Empty({ title, body }) {
  return (
    <div className="text-center py-14">
      <CalendarIcon size={26} className="mx-auto mb-3 text-slate-600" />
      <p className="text-slate-200 text-sm mb-1">{title}</p>
      <p className="text-slate-500 text-xs max-w-xs mx-auto leading-relaxed">{body}</p>
    </div>
  )
}

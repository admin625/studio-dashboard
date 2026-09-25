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
import { fmtSlotDay, fmtSlotMonthDay } from '../lib/slotDate'
import Layout from '../components/Layout'
import GenerateModal from '../components/GenerateModal'
import { NAV_ACTIVE, NAV_INACTIVE, NAV_ACTIVE_PILL } from '../lib/navColors'
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

// Both moved to lib/slotDate.js on 2026-09-18 so GenerateModal formats the slot's
// date by the same UTC rule. Aliased rather than renamed at every call site — the
// rule lives in one file now, which is the part that matters.
const fmtDay = fmtSlotDay
const fmtWeek = fmtSlotMonthDay

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
              aria-pressed={view === v}
              className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors"
              style={{
                // PR-4: the unselected view was #4a5568 on #0A0B0D (2.62:1). Same AA standard as the nav (PR-3).
                background: view === v ? NAV_ACTIVE_PILL : 'transparent',
                color: view === v ? NAV_ACTIVE : NAV_INACTIVE,
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
          // Keyed by slot id for the same reason DeliveryRoute is keyed by :id — React
          // reuses a component instance across prop changes, and SlotPanel's draft lives
          // in useState seeded once from `slot`. Today the panel always unmounts between
          // slots (openSlot goes null on close), so nothing leaks; a key makes that
          // structural instead of incidental, so a future "open the next slot directly"
          // cannot carry one slot's unsaved words onto another's.
          key={openSlot.id}
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
            // DO NOT CLOSE THE PANEL. Blocker 2, 2026-09-18: closing on success made a
            // save indistinguishable from a discard — the panel vanished either way,
            // which is how an unsaved edit passed for a saved one. The panel stays up
            // and says "Saved"; the owner decides when she is done.
            //
            // Reflect the write locally so the panel's own copy is not stale while the
            // week reloads behind it. `reason_source` flips to 'owner' because that is
            // what the endpoint will now resolve for this slot.
            setOpenSlot(s => (s ? { ...s, reason: text, reason_source: 'owner' } : s))
            // Refresh the week so the card behind the panel shows her words and the
            // "Your words" chip. Not awaited: the save has already succeeded, and a
            // slow reload must not hold up the confirmation she is waiting for.
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

      {/* Slot context is DISPLAY ONLY — the generator resolves the slot off slot_id.
          `reason` (not `rationale`) is the resolved field: the owner's own wording when she
          has edited it, the planner's otherwise.
          🚨 Corrected 2026-09-21: this said the generator "reads job, rationale and date" off
          the row. It read neither date nor rationale, and wrote for the day of the tap. It now
          reads slot_date, job, audience and this same resolved reason — see GenerateModal.
          onSubmitted(platforms, outcome?) must not close the modal: the outcome is shown there,
          and closing it hid every failure. `outcome` is present for every terminal state and
          absent when the modal closed on a synchronous 2xx or the owner closed it mid-run;
          either way the week just reloads. */}
      <GenerateModal
        open={!!genSlot}
        slotId={genSlot ? genSlot.id : null}
        slotJobLabel={genSlot ? genSlot.job_label : null}
        slotRationale={genSlot ? genSlot.reason : null}
        slotDate={genSlot ? genSlot.slot_date : null}
        // Reload on close too: the owner may close before the slot finished flipping.
        onClose={() => { setGenSlot(null); loadWeek(weekStart) }}
        onSubmitted={(_platforms, outcome) => {
          loadWeek(weekStart)
          // "delivered" is written as soon as the delivery row exists — BEFORE the post rows and
          // the slot flip land (Mark Delivered runs first so a failing email can't eat it). A
          // single reload here could show a written slot as unwritten and invite a duplicate, so
          // look again once those have had time to land.
          if (outcome && outcome.phase === 'delivered') {
            setTimeout(() => loadWeek(weekStart), 5000)
            setTimeout(() => loadWeek(weekStart), 15000)
          }
        }}
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

/**
 * SlotPanel — the slot, and the one field in this product the owner writes herself.
 *
 * 🚨 THE REASON EDIT NEEDS AN EXPLICIT SAVE, AND THE FIRST CUT DID NOT HAVE ONE.
 * Rehearsal blocker 2, 2026-09-18: the textarea was editable, the only control that
 * persisted it was labelled "That reason's right", and that button did double duty —
 * it saved when the text had changed and recorded an 'accepted' action when it had
 * not. An owner who has just REWRITTEN the reason does not read "that reason's right"
 * as "save what I typed"; she reads it as agreeing with what was already there. So
 * she closed the panel, the draft lived only in component state, and the edit was
 * gone on reload with nothing to say it had ever existed.
 *
 * `calendar_slot_rationales` held ZERO rows at the time of that rehearsal — across
 * every studio, for the entire life of the feature. The write path was not broken;
 * it was unreachable by anyone who did not already know the button was overloaded.
 *
 * Three things follow, and all three are requirements rather than styling:
 *   SAVE IS ITS OWN CONTROL, next to the field it saves, and says "Save".
 *   SAVING CONFIRMS VISIBLY and does NOT close the panel. Closing on success is how
 *     the first cut managed to look identical whether it had saved or not.
 *   A DIRTY DRAFT IS NEVER DISCARDED SILENTLY — closing with unsaved text asks first.
 *
 * ⚠️ NOT AUTOSAVE, deliberately. The rationale is the owner's own words and the
 * signal the whole co-design loop reads; a half-typed sentence committed on a
 * keystroke timer is worse than no edit at all. HQ ruling 2026-09-18.
 */
// Exported for test/slotReasonSave.test.jsx. The reason edit is the one field the owner
// writes herself, its write path had never once succeeded in production, and its failure
// mode is SILENT — the panel looked identical whether it saved or discarded. That is not
// a class of bug a pure-function test can reach, so it is render-tested.
export function SlotPanel({ slot, primary, onClose, onAct, onReason, onGenerate }) {
  // TWO states, not one. `saved` is what is persisted; `text` is the draft. A single
  // variable cannot tell an untouched field from an edited one, which is precisely
  // the distinction "unsaved changes" depends on.
  const [saved, setSaved] = useState(slot.reason || '')
  const [text, setText] = useState(slot.reason || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [justSaved, setJustSaved] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const trimmed = text.trim()
  const dirty = trimmed !== saved.trim()
  const canSave = dirty && trimmed.length > 0

  const run = async (fn) => {
    setBusy(true); setErr('')
    try { await fn() } catch (e) { setErr(e.message || 'That did not save.'); setBusy(false) }
  }

  // Clears busy on success, unlike the action handlers below — this is the one path
  // that leaves the panel mounted, so nothing else would ever re-enable the buttons.
  const save = () => run(async () => {
    await onReason(trimmed)
    setSaved(trimmed)
    setJustSaved(true)
    setConfirmDiscard(false)
    setBusy(false)
  })

  // The X and the backdrop both come through here. An unsaved draft stops and asks.
  const attemptClose = () => {
    if (dirty) { setConfirmDiscard(true); return }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      style={{ background: 'rgba(0,0,0,0.6)' }} onClick={attemptClose}>
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
          {/* aria-label because the only child is an icon — without it the control is
              nameless to a screen reader, and to any test that asks for it by name. */}
          <button type="button" aria-label="Close" onClick={attemptClose}
            className="text-slate-500 hover:text-white p-1"><X size={18} /></button>
        </div>

        <label className="block text-[11px] text-slate-400 mb-1.5" htmlFor="slot-reason">Why this post</label>
        <textarea
          id="slot-reason"
          value={text}
          onChange={e => {
            setText(e.target.value)
            // The confirmation describes the LAST save. Once she types again it is
            // stale, and a "Saved" sitting above unsaved text is the exact lie this
            // whole panel is being rebuilt to stop telling.
            setJustSaved(false)
            setConfirmDiscard(false)
          }}
          rows={3}
          className="w-full rounded-lg px-3 py-2 text-sm text-slate-100 mb-2"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
        />

        {/* SAVE LIVES HERE — beside the field, not among the slot actions below.
            Where the control sits is most of the fix: the old one was in the action
            row, where it read as a verdict on the plan rather than on her edit. */}
        <div className="flex items-center gap-3 mb-2 min-h-[34px]">
          <button
            type="button"
            onClick={save}
            disabled={!canSave || busy}
            className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-[11px]
                       font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: primary, color: '#0A0B0D' }}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            {busy ? 'Saving…' : 'Save reason'}
          </button>

          {/* Exactly one of these, in this order, so the state is never ambiguous.
              EMPTY IS CHECKED FIRST and independently of `dirty`: clearing the field
              is an edit, so the dirty branch would otherwise win and she would see
              "Unsaved changes" next to a disabled Save with nothing saying why. A
              disabled control that does not explain itself is the same dead end as
              the missing control this panel was rebuilt to fix. */}
          {trimmed.length === 0 && (
            <span className="text-[11px] text-amber-300">A reason can't be empty.</span>
          )}
          {trimmed.length > 0 && dirty && !busy && (
            <span className="text-[11px] text-amber-300">Unsaved changes</span>
          )}
          {trimmed.length > 0 && !dirty && justSaved && (
            <span className="text-[11px] flex items-center gap-1" style={{ color: '#34d399' }}>
              <Check size={12} /> Saved — this is the reason your plan shows now.
            </span>
          )}
        </div>

        <p className="text-[10px] text-slate-500 mb-4">
          {saved && slot.reason_source === 'owner'
            ? 'This is your wording. Your plan\'s original reason is kept.'
            : 'From your plan. Editing keeps the original.'}
        </p>

        {confirmDiscard && (
          <div className="rounded-lg px-3 py-2.5 mb-4"
            style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.25)' }}>
            <p className="text-[11px] text-amber-200 mb-2">
              You've changed this reason and haven't saved it. Close anyway?
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={onClose}
                className="px-3 py-1.5 rounded text-[11px] font-semibold text-slate-200"
                style={{ background: 'rgba(255,255,255,0.08)' }}>
                Discard my changes
              </button>
              <button type="button" onClick={() => setConfirmDiscard(false)}
                className="px-3 py-1.5 rounded text-[11px] font-semibold"
                style={{ background: primary, color: '#0A0B0D' }}>
                Keep editing
              </button>
            </div>
          </div>
        )}

        {slot.post_id && (
          <p className="text-[11px] mb-4" style={{ color: primary }}>A post has been written for this slot.</p>
        )}

        {err && <p className="text-[11px] text-red-300 mb-3">{err}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Action icon={PenLine} label="Write the post" disabled={busy}
            onClick={() => run(onGenerate)} bg={primary} solid />
          {/* PURE ACCEPT NOW. It no longer saves — that ambiguity was blocker 2.
              Disabled while dirty: accepting a reason she has just rewritten but not
              saved would record agreement with the OLD wording. */}
          <Action icon={Check} label="That reason's right" disabled={busy || dirty}
            onClick={() => run(() => onAct('accepted'))} />
          <Action icon={SkipForward} label="Skip this one" disabled={busy}
            onClick={() => run(() => onAct('skipped'))} />
        </div>
        {dirty && (
          <p className="text-[10px] text-slate-500 mt-2">
            Save your reason first, or discard it, to use “That reason's right”.
          </p>
        )}
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

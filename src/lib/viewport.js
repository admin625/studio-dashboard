/**
 * Phone width, for the few layout decisions JS has to make (UX ruling 2c, Mac 2026-10-08): which nav
 * to render (one at a time, so links are never duplicated) and where the help bubble sits. Tailwind's
 * sm breakpoint is 640px, so "phone" is anything narrower.
 *
 * subscribe and getSnapshot are module-level so they keep one identity: an inline subscribe makes
 * React drop and re-add the matchMedia listener on every render.
 */
import { useEffect, useSyncExternalStore } from 'react'

const PHONE_QUERY = '(max-width: 639px)'

/** Height of the phone bottom tab bar. The help bubble lifts by this plus a gap. */
export const PHONE_TAB_BAR_PX = 56

function mq() {
  return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_QUERY) : null
}

function subscribe(listener) {
  const m = mq()
  if (!m) return () => {}
  if (m.addEventListener) { m.addEventListener('change', listener); return () => m.removeEventListener('change', listener) }
  m.addListener(listener) // Safari < 14
  return () => m.removeListener(listener)
}

function getSnapshot() {
  const m = mq()
  return m ? m.matches : false
}

export function usePhoneWidth() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

// Whether the phone bottom bar is on screen. Layout reports it; the help bubble reads it, so the
// bubble lifts only where there is a bar (not on pages without Layout, not while a modal hides it).
let barShown = false
const barListeners = new Set()
const subscribeBar = (l) => { barListeners.add(l); return () => barListeners.delete(l) }
const getBar = () => barShown
const emitBar = () => barListeners.forEach((l) => l())

/** Layout: report whether the bar is showing. An effect, so the store is never written in render. */
export function useReportBottomBar(shown) {
  useEffect(() => {
    if (!shown) return undefined
    barShown = true
    emitBar()
    return () => { barShown = false; emitBar() }
  }, [shown])
}

export function useBottomBarShown() {
  return useSyncExternalStore(subscribeBar, getBar, () => false)
}

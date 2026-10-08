/**
 * How many modals are open right now (UX ruling 2c, Mac 2026-10-08). The help-chat bubble is a
 * fixed 56px circle at the bottom right, and on a phone it sat on top of whatever a modal put
 * there: the slot sheet's "Skip this one", the Create form's footnote, the watermark warning.
 * It now hides while any modal is open. A counter, not a flag, so two modals can't clear each
 * other.
 */
import { useEffect, useSyncExternalStore } from 'react'

let count = 0
const listeners = new Set()
const emit = () => listeners.forEach((l) => l())

export function subscribeModalOpen(l) { listeners.add(l); return () => listeners.delete(l) }
export function modalOpenCount() { return count }

/** Call from a modal: counts it as open while `open` is true and it is mounted. */
export function useModalOpen(open) {
  useEffect(() => {
    if (!open) return undefined
    count += 1
    emit()
    return () => { count -= 1; emit() }
  }, [open])
}

/** True while any modal is open. */
export function useAnyModalOpen() {
  return useSyncExternalStore(subscribeModalOpen, () => count > 0, () => false)
}

/** True on a phone-width screen (Tailwind's sm breakpoint is 640px). */
export function usePhoneWidth() {
  const q = '(max-width: 639px)'
  return useSyncExternalStore(
    (l) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const m = window.matchMedia(q)
      m.addEventListener ? m.addEventListener('change', l) : m.addListener(l)
      return () => (m.removeEventListener ? m.removeEventListener('change', l) : m.removeListener(l))
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : false),
    () => false,
  )
}

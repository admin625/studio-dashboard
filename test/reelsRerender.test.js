import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// reels.cjs is CommonJS (it requires _authz.cjs inside a "type":"module" package), so it is loaded with
// createRequire: the exact module Netlify bundles. Kept in test/, never beside the function — a *.test.js
// in netlify/functions/ fails the whole deploy.
const require = createRequire(import.meta.url)
const { rerenderGuard, foldHookIntoEdl, MAX_RENDERS } = require('../netlify/functions/reels.cjs')

const row = (over = {}) => ({ status: 'approved', render_status: 'delivered', render_count: 0, edl: {}, ...over })

describe('rerenderGuard — fast feedback before firing WF2 (WF2 owns the real cap)', () => {
  it('cap 3: the 3rd render is allowed, the 4th is refused with render_cap_reached', () => {
    expect(rerenderGuard(row({ render_count: 2 })).ok).toBe(true)      // this one becomes render 3
    const fourth = rerenderGuard(row({ render_count: 3 }))
    expect(fourth.ok).toBeUndefined()
    expect(fourth.status).toBe(409)
    expect(fourth.code).toBe('render_cap_reached')
    expect(fourth.error).toMatch(/rendered 3 times/)
  })

  it('NEGATIVE CONTROL: with a cap of 4 that same 4th render is allowed, so the number is doing the work', () => {
    expect(rerenderGuard(row({ render_count: 3 }), 4).ok).toBe(true)
  })

  it('every terminal render state can be re-rendered', () => {
    for (const s of ['delivered', 'render_failed', 'render_timeout', 'delivery_failed']) {
      expect(rerenderGuard(row({ render_status: s })).ok).toBe(true)
    }
  })

  it('mid-flight and un-approved reels are refused, and not as a cap refusal', () => {
    for (const s of ['rendering', 'delivering', null, undefined]) {
      const g = rerenderGuard(row({ render_status: s }))
      expect(g.status).toBe(409)
      expect(g.code).toBeUndefined()
      expect(g.error).toMatch(/still rendering/)
    }
    const pending = rerenderGuard(row({ status: 'pending_approval' }))
    expect(pending.status).toBe(409)
    expect(pending.error).toMatch(/has not been generated yet/)
    expect(rerenderGuard(null).status).toBe(404)
  })

  it('a missing render_count counts as zero, not as unlimited', () => {
    expect(rerenderGuard(row({ render_count: undefined })).ok).toBe(true)
    expect(rerenderGuard(row({ render_count: null })).ok).toBe(true)
    expect(MAX_RENDERS).toBe(3)
  })
})

describe('refusals say WHERE they came from', () => {
  // WF2's Respond Cap Reached emits this string. Copied verbatim from the running workflow
  // (kMYsBSkPnp5OsL7G, Respond Cap Reached) on 2026-09-23.
  const WF2_CAP_MESSAGE = 'This reel has been rendered 3 times. Start a new reel to keep going.'

  it('THE REASON THIS FIELD EXISTS: app and WF2 emit the identical message and code', () => {
    const appRefusal = rerenderGuard(row({ render_count: 3 }))
    expect(appRefusal.error).toBe(WF2_CAP_MESSAGE)   // character for character
    expect(appRefusal.code).toBe('render_cap_reached')
    // Message and code cannot tell them apart. Only source can.
    expect(appRefusal.source).toBe('app')
  })

  it('every app refusal carries source app, not just the cap one', () => {
    expect(rerenderGuard(null).source).toBe('app')
    expect(rerenderGuard(row({ status: 'pending_approval' })).source).toBe('app')
    expect(rerenderGuard(row({ render_status: 'rendering' })).source).toBe('app')
    expect(rerenderGuard(row({ render_count: 3 })).source).toBe('app')
  })

  it('NEGATIVE CONTROL: a permitted re-render carries no source at all', () => {
    const ok = rerenderGuard(row({ render_count: 1 }))
    expect(ok.ok).toBe(true)
    expect(ok.source).toBeUndefined()
    expect(ok.code).toBeUndefined()
  })
})

describe('foldHookIntoEdl — the capture must be able to say hook_edited', () => {
  const edl = { overlays: [{ text: 'Ready to move?', proposed_text: 'Ready to move?' }], timeline: [1] }

  it('an EDITED hook keeps the original proposal, so the capture records an edit', () => {
    const { edl: next, hook_edited, changed } = foldHookIntoEdl(edl, 'Last lift Friday. Come earn it.')
    expect(next.overlays[0].text).toBe('Last lift Friday. Come earn it.')
    expect(next.overlays[0].proposed_text).toBe('Ready to move?')
    // hook_edited in the DB is GENERATED as (final_text IS DISTINCT FROM proposed_text): these two
    // values are what WF2 inserts, so a difference here is exactly what makes the column true.
    expect(next.overlays[0].text).not.toBe(next.overlays[0].proposed_text)
    expect(hook_edited).toBe(true)
    expect(changed).toBe(true)
  })

  it('NEGATIVE CONTROL: overwriting the proposal would record every edit as unedited', () => {
    const wrong = JSON.parse(JSON.stringify(edl))
    wrong.overlays[0].proposed_text = 'Last lift Friday. Come earn it.' // what a naive fold would do
    wrong.overlays[0].text = 'Last lift Friday. Come earn it.'
    expect(wrong.overlays[0].text === wrong.overlays[0].proposed_text).toBe(true) // => hook_edited false
  })

  it('an UNEDITED re-render leaves the text alone and reports no edit', () => {
    const same = foldHookIntoEdl(edl, 'Ready to move?')
    expect(same.hook_edited).toBe(false)
    expect(same.changed).toBe(false)
    expect(same.edl.overlays[0].text).toBe('Ready to move?')
    const untouched = foldHookIntoEdl(edl, undefined)
    expect(untouched.changed).toBe(false)
    expect(untouched.edl.overlays[0].text).toBe('Ready to move?')
    expect(foldHookIntoEdl(edl, '   ').changed).toBe(false)
  })

  it('a first-ever edit seeds proposed_text from the current text', () => {
    const noProposal = { overlays: [{ text: 'Original hook' }] }
    const { edl: next, hook_edited } = foldHookIntoEdl(noProposal, 'New hook')
    expect(next.overlays[0].proposed_text).toBe('Original hook')
    expect(next.overlays[0].text).toBe('New hook')
    expect(hook_edited).toBe(true)
  })

  it('does not mutate the row it was given', () => {
    const original = JSON.parse(JSON.stringify(edl))
    foldHookIntoEdl(edl, 'Something else entirely')
    expect(edl).toEqual(original)
  })

  it('an EDL with no overlays is handled without throwing', () => {
    expect(foldHookIntoEdl({}, 'x').edl.overlays).toEqual([])
    expect(foldHookIntoEdl(null, 'x').hook_edited).toBe(false)
  })
})

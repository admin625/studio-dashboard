// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import React from 'react'

/**
 * UX ruling 2b (Mac 2026-10-08): the post's raw type ("CLASS_PROMO"), goal and image prompt are
 * working notes. They sit behind "Details", closed by default; the caption and Best Time stay.
 * The photo editor's button reads "New photo" (it was a second "Regenerate" on the page).
 */
vi.mock('../src/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }) },
  SUPABASE_URL: 'https://x.supabase.co', authedJsonHeaders: async () => ({}),
}))
vi.mock('../src/context/AppContext', () => ({
  useApp: () => ({ brandColorPrimary: '#bd8276', resolvedStudioId: 'studio-1', studioName: 'S', role: 'studio_owner', authReady: true }),
}))

const { default: PostCard } = await import('../src/components/PostCard.jsx')

const POST = {
  caption: 'Saturday classes hit different in October.', hashtags: '#a #b', format: 'feed_post',
  content_type: 'CLASS_PROMO', engagement_goal: 'Drive followers to book a class', optimal_posting_time: 'Saturday 7 AM',
  photo_url: 'https://x/p.jpg', needs_ai_image: false, image_prompt: 'Soft natural light, peaceful expressions', post_number: 1,
}
const card = (post = POST) => render(<PostCard post={post} index={0} platform="instagram" deliveryId="d" readOnly={false} createdAt="2026-10-08T15:38:29Z" />)
afterEach(cleanup)

describe('PostCard details', () => {
  it('closed by default: no raw type, no goal, no image prompt; caption and Best Time stay', () => {
    card()
    expect(document.body.textContent).not.toMatch(/CLASS_PROMO|Class promo/)
    expect(document.body.textContent).not.toContain('Drive followers to book a class')
    expect(document.body.textContent).not.toContain('Soft natural light')
    expect(document.body.textContent).toContain('Saturday classes hit different')
    expect(document.body.textContent).toContain('Saturday 7 AM')
  })

  it('Details opens type (in words), goal and prompt; the toggle is a 44px target', () => {
    card()
    const t = screen.getByRole('button', { name: /details/i })
    expect(t.className).toContain('min-h-[44px]')
    fireEvent.click(t)
    const d = screen.getByTestId('post-details')
    expect(d.textContent).toContain('Type: Class promo')
    expect(d.textContent).toContain('Goal: Drive followers to book a class')
    expect(t.getAttribute('aria-expanded')).toBe('true')
    expect(t.getAttribute('aria-controls')).toBe(d.id)
    expect(t.getAttribute('aria-label')).toBe('Details for post 1')
  })

  it('an AI photo: Details shows its prompt, cut at 120 with show more, and the Edit Photo pointer', () => {
    const long = 'Soft natural light, ' + 'calm '.repeat(40)
    card({ ...POST, matched_photo_id: null, image_prompt: long })
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    const d = screen.getByTestId('post-details')
    expect(d.textContent).toContain('Image prompt: Soft natural light')
    expect(d.textContent).toContain('…')
    expect(d.textContent).toContain('Change it in Edit Photo')
    fireEvent.click(screen.getByRole('button', { name: /show more/i }))
    expect(d.textContent).toContain(long.trim())
  })

  it('no photo yet: the prompt shows but the pointer to Edit Photo (which is not there) does not', () => {
    card({ ...POST, matched_photo_id: null, photo_url: null, needs_ai_image: true })
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    const d = screen.getByTestId('post-details')
    expect(screen.queryByRole('button', { name: /edit photo/i })).toBeNull()
    expect(d.textContent).not.toContain('Change it in Edit Photo')
  })

  it('negative control: a post with none of the three has no Details toggle', () => {
    card({ caption: 'x', hashtags: '', photo_url: null, optimal_posting_time: 'Mon' })
    expect(screen.queryByRole('button', { name: /details/i })).toBeNull()
  })

  it('the photo editor button reads "New photo", never "Regenerate"', () => {
    card()
    fireEvent.click(screen.getByRole('button', { name: /edit photo/i }))
    expect(screen.getByRole('button', { name: /new photo/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).toBeNull()
  })
})

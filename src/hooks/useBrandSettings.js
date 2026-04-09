import { useCallback } from 'react'
import { supabase, SUPABASE_URL } from '../lib/supabase'
import { useApp } from '../context/AppContext'

/**
 * All Supabase CRUD operations for brand settings.
 * Mirrors the legacy brandSaveBtn click handler, photo source change,
 * studio type change, logo upload, and photo prompt auto-save.
 */
export function useBrandSettings() {
  const app = useApp()
  const studioId = app.resolvedStudioId

  const saveBrand = useCallback(async (updates) => {
    if (!studioId) return
    const payload = {
      brand_color: updates.brandColorPrimary || null,
      brand_color_secondary: updates.brandColorSecondary || null,
      brand_font: updates.brandFont || null,
      brand_voice: updates.brandVoice || null,
    }
    await supabase.from('studio_accounts').update(payload).eq('id', studioId)
    app.update({
      brandColorPrimary: payload.brand_color || '',
      brandColorSecondary: payload.brand_color_secondary || '',
      brandFont: payload.brand_font || '',
      brandVoice: payload.brand_voice || '',
    })
  }, [studioId, app])

  const saveStudioType = useCallback(async (val) => {
    if (!studioId) return
    await supabase.from('studio_accounts').update({ studio_type: val || null }).eq('id', studioId)
    app.update({ studioType: val })
  }, [studioId, app])

  const savePhotoSource = useCallback(async (val) => {
    if (!studioId) return
    await supabase.from('studio_accounts').update({ photo_source: val }).eq('id', studioId)
    app.update({ photoSource: val })
  }, [studioId, app])

  const savePhotoPrompt = useCallback(async (val) => {
    if (!studioId) return
    await supabase.from('studio_accounts').update({ ai_photo_prompt: val }).eq('id', studioId)
    app.update({ aiPhotoPrompt: val })
  }, [studioId, app])

  const uploadLogo = useCallback(async (file) => {
    if (!studioId || !file) return
    const ext = file.name.split('.').pop()
    const path = `logos/${studioId}/logo.${ext}`
    const { error: upErr } = await supabase.storage.from('studio-photos').upload(path, file, { upsert: true })
    if (upErr) throw upErr
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/studio-photos/${path}`
    await supabase.from('studio_accounts').update({ logo_url: publicUrl }).eq('id', studioId)
    app.update({ brandLogoUrl: publicUrl })
    return publicUrl
  }, [studioId, app])

  return { saveBrand, saveStudioType, savePhotoSource, savePhotoPrompt, uploadLogo }
}

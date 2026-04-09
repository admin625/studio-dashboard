import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
  || 'https://kidgcrqxrfcbsaeguwop.supabase.co'

const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpZGdjcnF4cmZjYnNhZWd1d29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg2MzY5MzQsImV4cCI6MjA3NDIxMjkzNH0.7u__bKIRGD7xt3JcoME2CBjIF7dGdkqE24IQ26hCe3k'

console.log('[FCA] Supabase init:', {
  url: SUPABASE_URL ? SUPABASE_URL.substring(0, 30) + '...' : 'MISSING',
  keyDefined: !!SUPABASE_ANON_KEY,
  envUrl: import.meta.env.VITE_SUPABASE_URL ? 'from env' : 'hardcoded fallback',
  envKey: import.meta.env.VITE_SUPABASE_ANON_KEY ? 'from env' : 'hardcoded fallback',
})

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
export { SUPABASE_URL }

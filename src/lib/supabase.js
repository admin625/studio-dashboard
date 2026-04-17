import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
  || 'https://fidhmvuurygpknhshpml.supabase.co'

const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpZGhtdnV1cnlncGtuaHNocG1sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NDU4NjIsImV4cCI6MjA5MjAyMTg2Mn0.P2BZzkzPpTzUqWHdC9b0t_howmwHrNIr71ujMaT6aXM'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
export { SUPABASE_URL }

#!/usr/bin/env node
// ============================================================
// FCA Studio Dashboard — Create Supabase Auth Users
// ============================================================
// Usage:
//   SUPABASE_SERVICE_KEY=xxx node scripts/setup-fca-auth-users.js
//
// Passwords must be set via environment variables:
//   FCA_ADMIN_PW, FCA_KATIE_PW, FCA_JACKIE_PW, FCA_TEST_PW
//
// NEVER hardcode passwords in source files.
// ============================================================

const SUPABASE_URL = 'https://kidgcrqxrfcbsaeguwop.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SERVICE_KEY) {
  console.error('ERROR: Set SUPABASE_SERVICE_KEY environment variable');
  process.exit(1);
}

const USERS = [
  { email: 'admin@fiorsaoirse.com',           password: process.env.FCA_ADMIN_PW,  name: 'Mac (Admin)', role: 'studio_owner' },
  { email: 'katie@thelocalkollective.com',     password: process.env.FCA_KATIE_PW,  name: 'Katie',       role: 'studio_owner' },
  { email: 'jackie@thelocalkollective.com',    password: process.env.FCA_JACKIE_PW, name: 'Jackie',      role: 'studio_instructor' },
  { email: 'gurumcd@gmail.com',                password: process.env.FCA_TEST_PW,   name: 'Mac (Test)',  role: 'studio_instructor' },
];

// Validate all passwords are set
for (const u of USERS) {
  if (!u.password) {
    console.error('ERROR: Missing password env var for ' + u.email);
    console.error('Set: FCA_ADMIN_PW, FCA_KATIE_PW, FCA_JACKIE_PW, FCA_TEST_PW');
    process.exit(1);
  }
}

async function supaAdmin(path, opts = {}) {
  const resp = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...opts.headers },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(resp.status + ' ' + path + ': ' + text);
  return text ? JSON.parse(text) : null;
}

async function createUser(user) {
  try {
    const result = await supaAdmin('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: user.email, password: user.password, email_confirm: true, user_metadata: { name: user.name, role: user.role } }),
    });
    console.log('  Created: ' + user.email + ' (' + user.role + ') UID: ' + result.id);
    return result;
  } catch (err) {
    if (err.message.includes('already') || err.message.includes('exists')) {
      console.log('  Skipped: ' + user.email + ' (already exists)');
      return null;
    }
    throw err;
  }
}

async function main() {
  console.log('Creating FCA Dashboard auth users...\n');
  for (const user of USERS) await createUser(user);
  console.log('\nDone! Users should change their passwords after first login.');
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });

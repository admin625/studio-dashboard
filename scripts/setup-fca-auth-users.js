#!/usr/bin/env node
// ============================================================
// FCA Studio Dashboard — Create Supabase Auth Users
// ============================================================
// Usage:
//   SUPABASE_SERVICE_KEY=your-service-role-key node scripts/setup-fca-auth-users.js
//
// This script creates auth accounts for all FCA dashboard users.
// Run this ONCE before deploying the auth-enabled dashboard.
// ============================================================

const SUPABASE_URL = 'https://kidgcrqxrfcbsaeguwop.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SERVICE_KEY) {
  console.error('ERROR: Set SUPABASE_SERVICE_KEY environment variable');
  console.error('Usage: SUPABASE_SERVICE_KEY=xxx node scripts/setup-fca-auth-users.js');
  process.exit(1);
}

// Users to create — Mac distributes temporary passwords to each
const USERS = [
  {
    email: 'admin@fiorsaoirse.com',
    password: '***REDACTED***',
    name: 'Mac (Admin)',
    role: 'studio_owner',
  },
  {
    email: 'katie@thelocalkollective.com',
    password: '***REDACTED***',
    name: 'Katie',
    role: 'studio_owner',
  },
  {
    email: 'jackie@thelocalkollective.com',
    password: '***REDACTED***',
    name: 'Jackie',
    role: 'studio_instructor',
  },
  {
    email: 'gurumcd@gmail.com',
    password: '***REDACTED***',
    name: 'Mac (Test)',
    role: 'studio_instructor',
  },
];

async function supaAdmin(path, opts = {}) {
  const resp = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${resp.status} ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function createUser(user) {
  try {
    const result = await supaAdmin('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: user.email,
        password: user.password,
        email_confirm: true,
        user_metadata: { name: user.name, role: user.role },
      }),
    });

    console.log(`  Created: ${user.email} (${user.role})`);
    console.log(`    UID: ${result.id}`);
    console.log(`    Password: ${user.password}`);
    return result;
  } catch (err) {
    // User may already exist
    if (err.message.includes('already been registered') || err.message.includes('already exists')) {
      console.log(`  Skipped: ${user.email} (already exists)`);
      return null;
    }
    throw err;
  }
}

async function main() {
  console.log('Creating FCA Dashboard auth users...\n');

  for (const user of USERS) {
    await createUser(user);
  }

  console.log('\n--- Temporary Passwords ---');
  USERS.forEach(u => {
    console.log(`  ${u.email}: ${u.password}`);
  });

  console.log('\nUsers should change their passwords after first login.');
  console.log('Done!');
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});

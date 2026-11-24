#!/usr/bin/env node
/**
 * build-config.js — writes public/js/config.js from environment variables.
 * Vercel runs it as the build command (see vercel.json); server.js reuses it
 * to serve the same file locally from .env.
 *
 *   SUPABASE_URL        https://<project-ref>.supabase.co
 *   SUPABASE_ANON_KEY   the anon / publishable key (SUPABASE_PUBLISHABLE_KEY also works)
 *
 * The anon key is meant to be public: row-level security protects the data.
 * A service-role / secret key is refused, because it would bypass every rule.
 * Without the variables it writes the offline-demo config, except on Vercel,
 * where the build fails instead of publishing a site nobody can sign in to.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'js', 'config.js');

// Minimal .env reader (KEY=value per line); never overrides real env vars
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function readSupabaseEnv(env = process.env) {
  return {
    url: String(env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    key: String(env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || '').trim(),
  };
}

function isSecretKey(key) {
  if (/^sb_secret_/.test(key)) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.role === 'service_role';
  } catch (e) {
    return false;
  }
}

function validate({ url, key }) {
  if (url && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(url)) {
    throw new Error(`SUPABASE_URL should look like https://<project-ref>.supabase.co (got "${url}")`);
  }
  if (key && isSecretKey(key)) {
    throw new Error('SUPABASE_ANON_KEY is a service-role / secret key. Use the anon (publishable) key; the secret key must never reach a browser.');
  }
}

const HEADER = `/**
 * config.js — where the app finds Supabase
 *
 * Leave both values empty to run the offline demo (no sign-in, nothing saved).
 *  - Locally, \`npm start\` serves this file from SUPABASE_URL / SUPABASE_ANON_KEY
 *    in .env instead, so you normally never edit it.
 *  - On Vercel, the build step (scripts/build-config.js) rewrites it from the
 *    project's environment variables.
 * The anon / publishable key is designed to be public; row-level security in
 * the database is what protects the data. Never put the service-role key here.
 */
`;

function renderConfig({ url, key }) {
  return `${HEADER}window.APP_CONFIG = {\n  supabaseUrl: ${JSON.stringify(url)},\n  supabaseKey: ${JSON.stringify(key)},\n};\n`;
}

module.exports = { loadDotEnv, readSupabaseEnv, validate, renderConfig, isSecretKey };

if (require.main === module) {
  loadDotEnv();
  const cfg = readSupabaseEnv();
  try {
    validate(cfg);
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }
  if (!cfg.url || !cfg.key) {
    if (process.env.VERCEL) {
      console.error('✖ Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel → Project → Settings → Environment Variables, then redeploy.');
      process.exit(1);
    }
    console.warn('! SUPABASE_URL / SUPABASE_ANON_KEY not set: writing the offline-demo config.');
  }
  fs.writeFileSync(OUT, renderConfig(cfg));
  console.log(`✓ Wrote ${path.relative(ROOT, OUT)} (${cfg.url ? `Supabase: ${cfg.url}` : 'offline demo'})`);
}

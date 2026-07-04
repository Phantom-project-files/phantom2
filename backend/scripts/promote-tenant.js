// scripts/promote-tenant.js — push a locally-built tenant to prod (Phase 8).
//
//   node scripts/promote-tenant.js <slug> --to https://online-phantom.com \
//        --user vmathu20 --pass '<admin password>'
//
// Exports the local bundle, imports it on prod (ids remapped), then uploads every
// media file. Local run stays untouched. Prod slug collision aborts (409).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const slug = args[0];
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const TO = (opt('to') || '').replace(/\/$/, '');
const USER = opt('user');
const PASS = opt('pass');
if (!slug || !TO || !USER || !PASS) {
  console.error('usage: node scripts/promote-tenant.js <slug> --to <prod-url> --user <admin> --pass <password>');
  process.exit(1);
}

const { exportTenantBundle } = await import('../lib/promote.js');

console.log(`[promote] exporting '${slug}' from local db…`);
const bundle = exportTenantBundle(slug);
console.log(`[promote] ${bundle.pieces.length} pieces, ${bundle.media_assets.length} media assets`);

// admin login → cookie
const login = await fetch(`${TO}/admin/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (!login.ok) { console.error(`[promote] login failed: HTTP ${login.status}`); process.exit(1); }
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

const imp = await fetch(`${TO}/api/admin/import/tenant`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(bundle),
});
const impData = await imp.json();
if (!imp.ok || !impData.success) { console.error(`[promote] import failed: ${impData.error || imp.status}`); process.exit(1); }
console.log(`[promote] rows imported:`, impData.counts);

// upload media files
const LOCAL_MEDIA = process.env.PHANTOM_MEDIA_ROOT || path.join(__dirname, '..', 'data', 'media');
let up = 0, missing = 0;
for (const m of impData.media_manifest) {
  const fp = path.join(LOCAL_MEDIA, m.r2_key);
  if (!fs.existsSync(fp)) { console.warn(`  ! missing local file ${m.r2_key}`); missing++; continue; }
  const r = await fetch(`${TO}/api/admin/import/media?key=${encodeURIComponent(m.r2_key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': m.content_type || 'application/octet-stream', Cookie: cookie },
    body: fs.readFileSync(fp),
  });
  if (!r.ok) { console.error(`  ! upload failed ${m.r2_key}: HTTP ${r.status}`); process.exit(1); }
  up++;
  if (up % 20 === 0) console.log(`  … ${up}/${impData.media_manifest.length}`);
}
console.log(`[promote] DONE — ${up} file(s) uploaded${missing ? `, ${missing} missing locally` : ''}. Tenant '${slug}' is live on ${TO}.`);

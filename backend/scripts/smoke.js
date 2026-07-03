// scripts/smoke.js — $0 module-level smoke test (Phase 0 verification).
// Runs against a SCRATCH database — never touches the real one.
//
//   node scripts/smoke.js
//
// Verifies: migrations apply · admin upsert+session · events record/query ·
// jobs enqueue→run→done, retry backoff, billing circuit-breaker · llm mock ·
// storage local put/signedGet · fal mock submit.

import fs from 'fs';
import os from 'os';
import path from 'path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom2-smoke-'));
process.env.PHANTOM_DB_PATH = path.join(scratch, 'smoke.db');
process.env.CLAUDE_MODE = 'mock';
process.env.MOCK_MEDIA_GEN = '1';
process.env.STORAGE_BACKEND = 'local';

const { admins, adminSessions, events, jobs: jobStore, costEvents } = await import('../lib/db.js');
const jobs = await import('../lib/jobs.js');
const { llm } = await import('../lib/llm.js');
const { storage } = await import('../lib/storage.js');
const fal = (await import('../lib/fal.js')).default;
const { flushLogs, recentLogs } = await import('../lib/logs.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`);
  if (!cond) failures++;
}

console.log('[smoke] scratch db:', process.env.PHANTOM_DB_PATH);

// ── admins + sessions ──────────────────────────────────────────────────────
const admin = admins.ensureActive({ email: 'smoke@phantom.local', name: 'smoke', role: 'owner', passwordHash: 'x' });
check('admin upsert', admin && admin.status === 'active');
adminSessions.create({ id: 'smoke-session-id-000000000000000000000000000', adminId: admin.id, ttlSeconds: 60 });
check('admin session find', !!adminSessions.find('smoke-session-id-000000000000000000000000000'));

// ── events ─────────────────────────────────────────────────────────────────
events.record({ sessionKey: 'sess1', name: 'page.landing', path: '/' });
events.record({ sessionKey: 'sess1', name: 'intake.start', path: '/app/intake.html' });
const counts = events.countsSince(0);
check('events recorded + counted', counts.length === 2 && events.bySession('sess1').length === 2);

// ── llm mock ───────────────────────────────────────────────────────────────
const mockOut = await llm.complete({ task: 'extraction', prompt: 'hi', mock: '{"answer":42}' });
check('llm mock returns canned output', mockOut === '{"answer":42}');

// ── storage local ──────────────────────────────────────────────────────────
const key = storage.makeKey('smoke-co', 'post', 'txt');
await storage.put('smoke-co', key, Buffer.from('hello'), 'text/plain');
const signed = await storage.signedGet('smoke-co', key);
check('storage put + signedGet (local token URL)', signed.startsWith('/api/media/local/'));
let crossTenantBlocked = false;
try { await storage.signedGet('other-co', key); } catch { crossTenantBlocked = true; }
check('storage cross-tenant key blocked', crossTenantBlocked);

// ── fal mock ───────────────────────────────────────────────────────────────
const sub = await fal.submit('image', { prompt: 'x' });
check('fal mock submit', sub.mock === true && sub.request_id.startsWith('mock-image'));
const billErr = fal.classifyError(402, { detail: 'Insufficient balance' });
check('fal billing error classified', billErr.billing === true);

// ── jobs: happy path, retry, billing halt ──────────────────────────────────
let ran = 0;
jobs.register('smoke_ok', async (p) => { ran++; return { got: p.n }; }, { concurrency: 2 });
let attempts = 0;
jobs.register('smoke_retry', async () => { attempts++; if (attempts < 2) throw new Error('transient'); return { ok: true }; });
jobs.register('smoke_billing', async () => { const e = new Error('Insufficient credits'); e.billing = true; throw e; });

const okId = jobs.enqueue({ kind: 'smoke_ok', payload: { n: 7 } });
const billId = jobs.enqueue({ kind: 'smoke_billing', tenantSlug: 'acme' });
const sib1 = jobs.enqueue({ kind: 'smoke_billing', tenantSlug: 'acme' });
const sib2 = jobs.enqueue({ kind: 'smoke_billing', tenantSlug: 'acme' });
jobs.start();

await new Promise((r) => setTimeout(r, 1500));

const okRow = jobStore.byId(okId);
check('job runs to done with result', okRow.status === 'done' && JSON.parse(okRow.result).got === 7 && ran === 1);

const billRow = jobStore.byId(billId);
const sibRows = [jobStore.byId(sib1), jobStore.byId(sib2)];
const halted = sibRows.filter((r) => r.status === 'failed' && /halted/.test(r.error || '')).length;
check('billing job failed with BILLING error', billRow.status === 'failed' && /BILLING/.test(billRow.error));
check(`billing circuit-breaker halted siblings (${halted}/2)`, halted >= 1);

// retry path: run_after pushes into the future, so just verify it re-queued with attempts=1
const retryId = jobs.enqueue({ kind: 'smoke_retry' });
await new Promise((r) => setTimeout(r, 1200));
const retryRow = jobStore.byId(retryId);
check('failed job re-queued with backoff', retryRow.attempts === 1 && retryRow.status === 'queued' && retryRow.run_after > Math.floor(Date.now() / 1000));

// ── cost ledger ────────────────────────────────────────────────────────────
costEvents.record({ provider: 'fal', operation: 'smoke', usd: 0.01 });
check('cost event recorded', costEvents.totalsSince(0).some((r) => r.provider === 'fal'));

flushLogs();
check('billing halt logged', recentLogs({ limit: 50 }).some((l) => l.event === 'jobs.billing_halt'));

jobs.stop();
console.log(failures === 0 ? '\n[smoke] ALL PASS ✅' : `\n[smoke] ${failures} FAILURE(S) ❌`);
process.exit(failures === 0 ? 0 : 1);

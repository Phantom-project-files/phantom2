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

// ── Phase 1: offline end-to-end scrape (fixture HTML + mock LLM = $0) ───────
const fixture = path.join(scratch, 'fixture.html');
fs.writeFileSync(fixture, `<!doctype html><html><head>
<title>Acme Swim | Sustainable swimwear</title>
<meta name="description" content="Acme Swim makes sustainable swimwear in Los Angeles.">
<meta property="og:site_name" content="Acme Swim">
<meta property="og:image" content="https://acme.example/hero.jpg">
<link rel="icon" href="/favicon.png">
</head><body>
<h1>Swimwear that loves the ocean back</h1>
<h2>Our story</h2>
<p>Founded in 2021 in Los Angeles, Acme Swim solves fast-fashion waste with recycled fabrics.
We sell direct to consumers who care. Come meet the crew and shop the summer drop.</p>
<img src="https://cdn.shopify.com/acme/product-one.jpg">
<a href="/products/one-piece">One-piece</a>
<a href="/about">About us</a>
<a href="https://www.instagram.com/acmeswim">IG</a>
<a href="https://www.tiktok.com/@acmeswim">TikTok</a>
</body></html>`);
process.env.SCRAPE_OFFLINE = '1';
process.env.SCRAPE_FIXTURE_HTML = fixture;

process.env.STRIPE_MODE = 'mock';
process.env.EMAIL_MODE = 'mock';
const { registerScrapeJobs, startIntake } = await import('../lib/scrape/runner.js');
const { registerValuePropJobs } = await import('../lib/valueprop.js');
const { registerEmailJobs } = await import('../lib/email.js');
const { registerScriptGenJobs } = await import('../lib/scriptgen/index.js');
const { intakes, scrapeSources, purchases, users, orgs, phantoms, campaigns, pieces } = await import('../lib/db.js');
registerScrapeJobs();
registerValuePropJobs();
registerEmailJobs();
registerScriptGenJobs();

const { intake, tenant } = startIntake({ businessName: 'Acme Swim', website: 'acme-swim.example' });
check('intake + tenant minted', !!intake.id && /^acme-swim-/.test(tenant.slug));

await new Promise((r) => setTimeout(r, 2500));
const doneIntake = intakes.byId(intake.id);
check(`scrape job completed (status=${doneIntake.status})`, ['scraped', 'partial'].includes(doneIntake.status));
check('scrape.json persisted to storage', !!doneIntake.scrape_key && doneIntake.scrape_key.startsWith(`tenants/${tenant.slug}/scrapes/`));
check('llm budget counted', doneIntake.llm_calls >= 5);

const srcRows = scrapeSources.byIntake(intake.id);
const bySource = Object.fromEntries(srcRows.map((s) => [s.source, s.status]));
check('website source scraped', bySource.website === 'scraped');
check('social probes skipped offline (honest flag)', bySource.instagram === 'skipped' && bySource.tiktok === 'skipped');

const scrapeUrl = await storage.signedGet(tenant.slug, doneIntake.scrape_key);
check('scrape artifact signed URL mints', scrapeUrl.startsWith('/api/media/local/'));
const scrapeDoc = JSON.parse(fs.readFileSync(
  path.join(path.dirname(new URL('../lib/db.js', import.meta.url).pathname), '..', 'data', 'media', doneIntake.scrape_key), 'utf8'));
check('scrape.json has taxonomy sections (about/target_market/vertical)',
  !!scrapeDoc.about && !!scrapeDoc.target_market && !!scrapeDoc.vertical
  && scrapeDoc.about.business_name === 'Mock Brand');
check('deterministic layer real (shopify detected, IG handle found)',
  scrapeDoc.crawl.tech.shopify === true && scrapeDoc.social_media.handles.instagram === 'acmeswim');

// ── Phase 2: funnel — value prop → plan → checkout(mock) → paid → email ─────
await new Promise((r) => setTimeout(r, 1500));   // value_prop job chained after scrape
const vpIntake = intakes.byId(intake.id);
const vp = vpIntake.value_prop ? JSON.parse(vpIntake.value_prop) : null;
check('value_prop job produced exactly 3 frames', vp && vp.frames.length === 3 && !!vp.frames[0].headline);

const { TIERS, TIER_CONFIG } = await import('../lib/tiers.js');
check('tiers config (4 tiers, BPMN prices + overkill 100/140)',
  TIERS.length === 4 && TIER_CONFIG.standard.price === 800 && !TIER_CONFIG.standard.recurring
  && TIER_CONFIG.overkill.price === 4000 && TIER_CONFIG.overkill.reels === 100 && TIER_CONFIG.overkill.posts === 140);

const { isEntitled } = await import('../lib/entitlement.js');
const { createCheckout, markIntakePaid, handleStripeEvent, verifyStripeSignature } = await import('../lib/payments.js');
check('unpaid intake is not entitled', isEntitled(vpIntake) === false);

intakes.patch(intake.id, { plan: 'premium' });
const session = await createCheckout({ intake: intakes.byId(intake.id), plan: 'premium', baseUrl: 'http://localhost:3020' });
check('mock checkout session + purchase row', session.mock === true && !!purchases.bySessionId(session.id));

// simulate the user having claimed the intake (OAuth) so the payment email has a recipient
const smokeUser = users.upsertFromGoogle({ sub: 'gsub-smoke', email: 'buyer@example.com', name: 'Buyer' });
const smokeOrg = orgs.create('Acme Swim');
users.setOrg(smokeUser.id, smokeOrg.id);
intakes.patch(intake.id, { orgId: smokeOrg.id, claimedUserId: smokeUser.id });

const hookResult = handleStripeEvent({
  type: 'checkout.session.completed',
  data: { object: { id: session.id, metadata: { intake_id: intake.id, plan: 'premium' } } },
});
check('stripe webhook event marks intake paid', hookResult.ok === true && isEntitled(intakes.byId(intake.id)));
check('purchase marked paid', purchases.bySessionId(session.id).status === 'paid');

await new Promise((r) => setTimeout(r, 1200));   // email job drains
check('payment email delivered (mock)', events.countsSince(0).some((e) => e.name === 'email.sent'));

const override = markIntakePaid(intake.id, { via: 'admin_override', plan: 'ultra' });
check('admin override path entitles + swaps plan', override.payment_status === 'admin_override' && override.plan === 'ultra');

// ── Phase 3: script-gen — phantoms, campaigns, calendar, briefs ($0 mock) ────
// markIntakePaid fired twice above (stripe premium + override ultra) — the first
// script_gen run builds premium's 30/30; the second must skip (guard).
await new Promise((r) => setTimeout(r, 4000));
const cast = phantoms.byTenant(tenant.slug);
check('6 phantoms cast', cast.length === 6 && !!cast[0].appearance_prompt);

const camps = campaigns.byIntake(intake.id);
check(`campaigns ideated in range (got ${camps.length})`, camps.length >= 3 && camps.length <= 30);
check('campaign has shared visual design + type', !!camps[0].visual_design && !!camps[0].type);

const allPieces = pieces.byIntake(intake.id);
const reels = allPieces.filter((p) => p.kind === 'reel');
const posts = allPieces.filter((p) => p.kind === 'post');
check(`premium counts honored (30 reels + 30 posts, got ${reels.length}/${posts.length})`, reels.length === 30 && posts.length === 30);
check('guard: second paid trigger did not duplicate production', allPieces.length === 60);

const cal = pieces.calendar(intake.id);
check('calendar: 30 days, premium = exactly 1 reel + 1 post per day',
  cal.length === 30 && cal.every((d) => d.reels === 1 && d.posts === 1));

const usedPhantoms = new Set(allPieces.map((p) => p.phantom_id));
check('all 6 phantoms used across pieces', usedPhantoms.size === 6);

const pillarCounts = posts.reduce((m, p) => { m[p.pillar] = (m[p.pillar] || 0) + 1; return m; }, {});
check(`pillar split over 30 posts (product 12 / brand 8 / educational 6 / lifestyle 4) → ${JSON.stringify(pillarCounts)}`,
  pillarCounts.product === 12 && pillarCounts.brand === 8 && pillarCounts.educational === 6 && pillarCounts.lifestyle === 4);

const sampleReel = JSON.parse(reels[0].brief);
const samplePost = JSON.parse(posts[0].brief);
check('reel brief contract (hook/frames≤3/video/audio/graphics/caption)',
  !!sampleReel.hook && Array.isArray(sampleReel.frame_prompts) && sampleReel.frame_prompts.length <= 3
  && !!sampleReel.video_description && !!sampleReel.audio_vibe && !!sampleReel.graphics_notes && !!sampleReel.caption);
check('post brief contract (post_prompt/design_prompt/caption)',
  !!samplePost.post_prompt && !!samplePost.design_prompt && !!samplePost.caption);

// sandbox custom counts + regenerate (the operator's "choose the amount" ask)
const { runScriptGen } = await import('../lib/scriptgen/index.js');
const custom = await runScriptGen({ intakeId: intake.id, reels: 4, posts: 2, regenerate: true });
const customPieces = pieces.byIntake(intake.id);
check('sandbox regenerate with custom counts (4 reels / 2 posts)',
  custom.ok === true && customPieces.filter((p) => p.kind === 'reel').length === 4
  && customPieces.filter((p) => p.kind === 'post').length === 2);

const { activeMoments } = await import('../lib/moments.js');
const mom = activeMoments({ now: new Date('2026-07-02T12:00:00Z'), location: 'Los Angeles' });
check('moments feed: FIFA WC active on 2026-07-02 + summer season',
  mom.some((m) => m.key === 'fifa_wc_2026' && m.active) && mom.some((m) => m.key === 'season' && /summer/.test(m.label)));

const sigCheck = verifyStripeSignature('{}', null);
check('webhook unsigned-dev-mode accepted when no secret', sigCheck.ok === true && sigCheck.unsigned === true);
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
const sigBad = verifyStripeSignature('{}', 't=1,v1=deadbeef');
delete process.env.STRIPE_WEBHOOK_SECRET;
check('webhook bad signature rejected when secret set', sigBad.ok === false);

flushLogs();
check('billing halt logged', recentLogs({ limit: 100 }).some((l) => l.event === 'jobs.billing_halt'));

jobs.stop();
console.log(failures === 0 ? '\n[smoke] ALL PASS ✅' : `\n[smoke] ${failures} FAILURE(S) ❌`);
process.exit(failures === 0 ? 0 : 1);

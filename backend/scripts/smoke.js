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

// ── Phase 4: media engine — full mock chain (submit → poll → chain → R2) ────
// current state: 4 reels + 2 posts (from the sandbox regenerate above)
const { registerMediaJobs, generateMedia, estimateForIntake, onFalWebhook } = await import('../lib/media/render.js');
const { mediaAssets } = await import('../lib/db.js');
registerMediaJobs();

const est = estimateForIntake(intake.id);
check('estimate: 6 faces + shot reuse math + $ figure',
  est.phantoms === 6 && est.reels === 4 && est.posts === 2
  && est.video_shots + est.reused_shots === 8   // 4 reels × 2 mock frames
  && est.reused_shots >= 1 && typeof est.est_usd === 'number' && est.mock_mode === true);

const kicked = generateMedia({ intakeId: intake.id });
check('generate-media kicks everything pending', kicked.phantoms === 6 && kicked.reels === 4 && kicked.posts === 2);

// mock chain: phantoms render → reels wait on refs (retryable) → keyframe → video → shot
await new Promise((r) => setTimeout(r, 5000));
const phReady = phantoms.byTenant(tenant.slug).filter((p) => p.intake_id === intake.id && p.status === 'ready');
check('all 6 phantom faces ready with R2 ref keys', phReady.length === 6 && phReady.every((p) => p.ref_image_key));

let mediaPieces = pieces.byIntake(intake.id);
for (let i = 0; i < 20 && mediaPieces.some((p) => p.status !== 'ready'); i++) {
  await new Promise((r) => setTimeout(r, 1500));
  mediaPieces = pieces.byIntake(intake.id);
}
check(`all pieces reach ready (${mediaPieces.filter((p) => p.status === 'ready').length}/6)`,
  mediaPieces.every((p) => p.status === 'ready'));

const shots = mediaAssets.byTenantKind(tenant.slug, 'shot');
check(`shot library populated with reuse (${shots.length} fresh shots for 4 reels × 2 frames)`,
  shots.length === est.video_shots && shots.length < 8);
const postAssets = mediaAssets.byTenantKind(tenant.slug, 'post');
check('post images in media_assets', postAssets.length === 2);
check('fal spend recorded at $0 (mock)', costEvents.totalsSince(0).some((r) => r.provider === 'fal'));

const pollJobId = jobs.enqueue({ kind: 'fal_poll', tenantSlug: tenant.slug, refKind: 'fal_request', refId: 'wh-test', payload: { requestId: 'wh-test', modelKey: 'image', next: { action: 'ingest_post', ctx: { pieceId: mediaPieces[0].id } } }, runAfter: Math.floor(Date.now() / 1000) + 999 });
check('webhook accelerates queued poll to now', onFalWebhook('wh-test') === 1 && jobStore.byId(pollJobId).run_after === 0);
jobStore.fail(pollJobId, 'smoke cleanup');

// ── Phase 5: edit layer — beat-cut, graphics seam, post composer ─────────────
const { registerEditJobs } = await import('../lib/edit/assemble.js');
const { registerComposeJobs } = await import('../lib/edit/post-compose.js');
const { pickArchetype } = await import('../lib/edit/post-compose.js');
const { audioTracks } = await import('../lib/db.js');
const { scoreTrack, pickTrack, buildCutPlan, detectCuts, ffmpegAvailable, FFMPEG } = await import('../lib/edit/audio.js');
registerEditJobs();
registerComposeJobs();

// seed the operator audio library (mock bytes are fine — mock assembly doesn't decode)
const trackKey = storage.makeKey('library', 'audio', 'mp3');
await storage.put('library', trackKey, Buffer.from('mock-mp3'), 'audio/mpeg');
audioTracks.add({ title: 'Summer Heat', artist: 'Test', licenseNote: 'smoke', r2Key: trackKey, vibeTags: ['upbeat', 'summer', 'pop'] });
const trackKey2 = storage.makeKey('library', 'audio', 'mp3');
await storage.put('library', trackKey2, Buffer.from('mock-mp3'), 'audio/mpeg');
audioTracks.add({ title: 'Dark Luxury', artist: 'Test', licenseNote: 'smoke', r2Key: trackKey2, vibeTags: ['moody', 'luxury'] });

check('track selection scores vibe overlap', pickTrack('upbeat summer pop').track.title === 'Summer Heat'
  && scoreTrack('upbeat summer pop', { vibe_tags: '["upbeat","pop"]' }) === 2);

const plan = buildCutPlan({ shotCount: 3, targetSec: 18, onsets: [5.8, 12.2] });
check('cut plan snaps transitions to onsets', plan.length === 3
  && plan[0].end === 5.8 && plan[1].end === 12.2 && plan[2].end === 18 && plan[0].snapped && plan[1].snapped);

// the auto-chain enqueued assemble_reel/compose_post when Phase-4 pieces flipped ready
let finals = { reel: 0, post_final: 0 };
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  finals.reel = mediaAssets.byTenantKind(tenant.slug, 'reel').length;
  finals.post_final = mediaAssets.byTenantKind(tenant.slug, 'post_final').length;
  if (finals.reel >= 4 && finals.post_final >= 2) break;
}
check(`auto-chain assembled final reels (${finals.reel}/4) + composed posts (${finals.post_final}/2)`,
  finals.reel === 4 && finals.post_final === 2);

const sampleAssembled = mediaAssets.byTenantKind(tenant.slug, 'reel')[0];
const asmMeta = JSON.parse(sampleAssembled.meta);
check('assembled reel meta: edit_plan + track pick + shot provenance',
  Array.isArray(asmMeta.edit_plan) && asmMeta.track_id != null && Array.isArray(asmMeta.shots));
const reusedInAssembly = mediaAssets.byTenantKind(tenant.slug, 'reel')
  .flatMap((a) => JSON.parse(a.meta).shots).filter((s) => s.reused).length;
check(`assembly pulled reused shots from the campaign pool (${reusedInAssembly})`, reusedInAssembly >= 3);

check('archetype picker (stat/quote/hero)', pickArchetype('oversized number stat') === 'stat_card'
  && pickArchetype('bold quote layout') === 'quote' && pickArchetype('anything else') === 'product_hero');

// ── Phase 6: QC — approve/reject → regen (cap 3) → learnings → coverage ─────
const { applyVerdict } = await import('../lib/qc.js');
const { rollup, summarizeLearnings, brandLearningsBlock } = await import('../lib/qc-learnings.js');
const { coverageReport } = await import('../lib/coverage.js');
const { qcVerdicts } = await import('../lib/db.js');

const qcPieces = pieces.byIntake(intake.id);
const aReel = qcPieces.find((p) => p.kind === 'reel');
const aPost = qcPieces.find((p) => p.kind === 'post');

const appr = applyVerdict({ pieceId: aPost.id, verdict: 'approve' });
check('QC approve → status approved + verdict row', appr.status === 'approved'
  && pieces.byId(aPost.id).status === 'approved'
  && qcVerdicts.byIntake(intake.id).some((v) => v.piece_id === aPost.id && v.verdict === 'approve'));

const oldReelAssets = mediaAssets.byRef('piece', aReel.id).map((a) => a.id);
const rej = applyVerdict({ pieceId: aReel.id, verdict: 'reject', reasonText: 'phantom looks stiff, motion too slow', reasonTags: ['face_quality', 'motion'] });
check('QC reject → regen 1/3, feedback in brief, artifacts cleared', rej.status === 'rendering' && rej.regen === 1
  && JSON.parse(pieces.byId(aReel.id).brief).regen_feedback.includes('stiff')
  && mediaAssets.byRef('piece', aReel.id).filter((a) => oldReelAssets.includes(a.id)).length === 0);

// regenerated reel flows back through render → shots → assembly
let regenReel = pieces.byId(aReel.id);
for (let i = 0; i < 20 && regenReel.status !== 'ready'; i++) { await new Promise((r) => setTimeout(r, 1000)); regenReel = pieces.byId(aReel.id); }
const newReelFinal = mediaAssets.byRef('piece', aReel.id).find((a) => a.kind === 'reel');
check('regenerated reel re-rendered + re-assembled with NEW assets', regenReel.status === 'ready' && !!newReelFinal && !oldReelAssets.includes(newReelFinal.id));

// burn through the cap: rejects 2 and 3 regen, the 4th hard-rejects
applyVerdict({ pieceId: aReel.id, verdict: 'reject', reasonText: 'caption off-brand', reasonTags: ['caption'] });
for (let i = 0; i < 20 && pieces.byId(aReel.id).status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 1000));
applyVerdict({ pieceId: aReel.id, verdict: 'reject', reasonText: 'wrong product angle', reasonTags: ['product'] });
for (let i = 0; i < 20 && pieces.byId(aReel.id).status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 1000));
const capHit = applyVerdict({ pieceId: aReel.id, verdict: 'reject', reasonText: 'still wrong', reasonTags: ['product'] });
check(`regen cap enforced at 3 (4th reject → rejected, capped)`, capHit.capped === true
  && pieces.byId(aReel.id).status === 'rejected' && pieces.byId(aReel.id).regen_count === 3);

// learnings: rollup + cached summary + injection block
const ro = rollup(tenant.slug);
check('learnings rollup (rate + top tags + reasons)', ro.total >= 5 && ro.top_tags.length >= 2 && ro.recent_reasons.length >= 3);
const bullets = await summarizeLearnings(tenant.slug);
const bullets2 = await summarizeLearnings(tenant.slug); // second call must hit the volume cache
check('learnings summarized + volume-cached', bullets.length >= 1 && JSON.stringify(bullets) === JSON.stringify(bullets2));
const block = await brandLearningsBlock(tenant.slug);
check('<brand_learnings> block builds', block.includes('<brand_learnings>') && block.includes(bullets[0]));

// scriptgen consumes the learnings on the next batch
const regen2 = await runScriptGen({ intakeId: intake.id, reels: 2, posts: 2, regenerate: true });
check('next batch runs with learnings applied', regen2.ok === true);

const cov = coverageReport(intake.id);
check('coverage report (pillars/phantoms/qc buckets + custom-build detection)',
  cov.counts.reels === 2 && cov.counts.custom_build === true
  && cov.pillars.length === 4 && cov.phantoms.cast === 6 && typeof cov.green === 'boolean');

// ── Phase 7: deploy + tracker — connect → calendar deploy → metrics → report ─
process.env.AYRSHARE_MODE = 'mock';
const { connectTenant, deploySchedule, registerDeployJobs } = await import('../lib/deploy/index.js');
const { registerTrackerJobs, runMonthEndReport, performanceRules } = await import('../lib/tracker/index.js');
const { deployments, metrics: metricsStore, reports } = await import('../lib/db.js');
registerDeployJobs();
registerTrackerJobs();

// current intake state: 2 reels + 2 posts from the learnings-regenerate batch — render + approve them
generateMedia({ intakeId: intake.id });
let p7pieces = pieces.byIntake(intake.id);
for (let i = 0; i < 30 && p7pieces.some((p) => p.status !== 'ready'); i++) {
  await new Promise((r) => setTimeout(r, 1000));
  p7pieces = pieces.byIntake(intake.id);
}
for (const p of p7pieces) applyVerdict({ pieceId: p.id, verdict: 'approve' });

// standard tier must refuse auto-deploy (gallery/ZIP only)
intakes.patch(intake.id, { plan: 'standard' });
let standardBlocked = false;
try { deploySchedule({ intakeId: intake.id }); } catch (e) { standardBlocked = /no auto-deploy/.test(e.message); }
check('standard tier blocked from auto-deploy (gallery-only)', standardBlocked);
intakes.patch(intake.id, { plan: 'premium' });

const conn = await connectTenant(tenant.slug);
check('ayrshare profile + connect URL (mock)', conn.connection.ayrshare_profile_key.startsWith('mock-profile-') && conn.connect_url.includes('connect'));

const dep = deploySchedule({ intakeId: intake.id });
check(`deploy queued for all approved pieces (${dep.queued})`, dep.queued === 4);
let depRows = [];
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  depRows = deployments.byIntake(intake.id);
  if (depRows.length === 4) break;
}
check('deployments created with ayrshare ids + calendar dates', depRows.length === 4
  && depRows.every((d) => d.ayrshare_post_id?.startsWith('mock-post-') && d.status === 'scheduled' && d.scheduled_at));
check('re-deploy is idempotent (active deployments skipped)', deploySchedule({ intakeId: intake.id }).queued === 0);

// tracker: analytics success on a scheduled post ⇒ implicit publish + metric rows
jobs.enqueue({ kind: 'track_metrics', tenantSlug: tenant.slug, payload: { tenantSlug: tenant.slug } });
await new Promise((r) => setTimeout(r, 2000));
const capturedMetrics = metricsStore.byTenantSince(tenant.slug, 0);
check(`metrics captured (${capturedMetrics.length} rows) + scheduled→published sync`,
  capturedMetrics.length === 4 && deployments.byTenantStatus(tenant.slug, 'published').length === 4);

const monthEnd = await runMonthEndReport({ tenantSlug: tenant.slug });
check('month-end report (winners + narrative + performance rules)',
  monthEnd.report.deployed_pieces === 4 && monthEnd.report.winners.length >= 1
  && !!monthEnd.report.narrative && monthEnd.report.performance_rules.length >= 1);
check('report persisted + queryable', !!reports.latest(tenant.slug));
check('tracker performance rules feed brand learnings', performanceRules(tenant.slug).length >= 1
  && (await brandLearningsBlock(tenant.slug)).includes('[performance]'));

await new Promise((r) => setTimeout(r, 1200)); // email lane drains
check('month-end email fired (mock)', events.countsSince(0).some((e) => e.name === 'email.sent' || e.name === 'email.skipped_no_recipient'));

// ── Phase 8: funnel math, gallery/zip data, MEDIA_AUTOGEN, promote bundle ────
// funnel: 3 sessions land, 2 submit, 1 pays
for (const [sess, stages] of Object.entries({
  s1: ['page.index', 'intake.submitted', 'funnel.paid'],
  s2: ['page.index', 'intake.submitted'],
  s3: ['page.index'],
})) for (const name of stages) events.record({ sessionKey: sess, name });
const funnelRows = events.funnel(['page.index', 'intake.submitted', 'funnel.paid'], 0);
check('funnel: distinct sessions per stage (3→2→1)',
  funnelRows[0].sessions === 3 && funnelRows[1].sessions === 2 && funnelRows[2].sessions === 1);

// deployed intakes refuse full regenerate (published content is a record)
let regenBlocked = false;
try { await runScriptGen({ intakeId: intake.id, reels: 1, posts: 1, regenerate: true }); }
catch (e) { regenBlocked = /deployments — full regenerate is blocked/.test(e.message); }
check('full regenerate blocked once content deployed (per-piece QC regen stays open)', regenBlocked);

// MEDIA_AUTOGEN on a FRESH intake: scriptgen chains straight into render jobs
const fresh = startIntake({ businessName: 'Autogen Co', website: 'autogen.example' });
for (let i = 0; i < 20 && !intakes.byId(fresh.intake.id).scrape_key; i++) await new Promise((r) => setTimeout(r, 800));
process.env.MEDIA_AUTOGEN = '1';
await runScriptGen({ intakeId: fresh.intake.id, reels: 1, posts: 1 });
delete process.env.MEDIA_AUTOGEN;
let agPieces = pieces.byIntake(fresh.intake.id);
for (let i = 0; i < 30 && (agPieces.length < 2 || agPieces.some((p) => p.status !== 'ready')); i++) {
  await new Promise((r) => setTimeout(r, 1000));
  agPieces = pieces.byIntake(fresh.intake.id);
}
check('MEDIA_AUTOGEN chains scriptgen → render without a click',
  agPieces.length === 2 && agPieces.every((p) => p.status === 'ready'));
for (const p of agPieces) applyVerdict({ pieceId: p.id, verdict: 'approve' });
await new Promise((r) => setTimeout(r, 2500)); // assembly/compose finals land

// gallery data shape (finals present for approved pieces)
const galleryFinals = agPieces.map((p) => mediaAssets.byRef('piece', p.id)
  .find((a) => a.kind === (p.kind === 'reel' ? 'reel' : 'post_final'))).filter(Boolean);
check('gallery finals exist for approved pieces', galleryFinals.length === 2);

// promote: export the RICH tenant → import into the same scratch db under a new slug (id remap proof)
const { exportTenantBundle, importTenantBundle } = await import('../lib/promote.js');
const bundle = exportTenantBundle(tenant.slug);
check('export bundle complete (tenant/pieces/media/qc)',
  bundle.tenant.slug === tenant.slug && bundle.pieces.length === 4
  && bundle.media_assets.length > 0 && bundle.qc_verdicts.length > 0 && bundle.phantoms.length === 6);
const cloned = JSON.parse(JSON.stringify(bundle));
cloned.tenant.slug = 'promoted-clone-x1y2';
for (const arr of ['intakes', 'phantoms', 'campaigns', 'pieces', 'qc_verdicts', 'media_assets']) {
  for (const r of cloned[arr]) {
    r.tenant_slug = 'promoted-clone-x1y2';
    if (r.r2_key) r.r2_key = r.r2_key.replace(`tenants/${tenant.slug}/`, 'tenants/promoted-clone-x1y2/');
    if (r.scrape_key) r.scrape_key = null;
    if (r.id && arr === 'intakes') r.id = 'clone-' + r.id;
    if (r.intake_id) r.intake_id = 'clone-' + r.intake_id;
  }
}
const imported = importTenantBundle(cloned);
check('import remaps ids + returns media manifest',
  imported.slug === 'promoted-clone-x1y2' && imported.counts.pieces === 4
  && imported.counts.phantoms === 6 && imported.media_manifest.length === cloned.media_assets.length);
const clonePieces = pieces.byIntake('clone-' + intake.id);
check('imported pieces re-linked to remapped campaigns/phantoms',
  clonePieces.length === 4 && clonePieces.every((p) => p.campaign_id > 0 && p.phantom_id > 0)
  && clonePieces[0].campaign_id !== bundle.pieces[0].campaign_id);
let dupBlocked = false;
try { importTenantBundle(cloned); } catch (e) { dupBlocked = e.status === 409; }
check('re-import of existing slug → 409', dupBlocked);

// REAL ffmpeg onset detection on a synthetic track: quiet base + 3 loud bursts.
if (await ffmpegAvailable()) {
  const { spawn } = await import('child_process');
  const tonePath = path.join(scratch, 'bursts.wav');
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', "sine=frequency=200:duration=12",
      '-af', "volume='if(between(t,3,3.6)+between(t,6,6.6)+between(t,9,9.6),1.0,0.05)':eval=frame",
      tonePath]);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('tone gen failed'))));
    p.on('error', reject);
  });
  const det = await detectCuts(tonePath, { minGapSec: 1 });
  const hits = [3, 6, 9].filter((t) => det.onsets.some((o) => Math.abs(o - t) < 0.3)).length;
  check(`REAL ffmpeg onset detection finds the 3 bursts (found ${det.onsets.length} onsets, ${hits}/3 at burst times)`, hits === 3);
} else {
  console.log('  ~ skipped: real ffmpeg onset test (ffmpeg not installed)');
}

const sigCheck = verifyStripeSignature('{}', null);
check('webhook unsigned-dev-mode accepted when no secret', sigCheck.ok === true && sigCheck.unsigned === true);
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
const sigBad = verifyStripeSignature('{}', 't=1,v1=deadbeef');
delete process.env.STRIPE_WEBHOOK_SECRET;
check('webhook bad signature rejected when secret set', sigBad.ok === false);

flushLogs();
check('billing halt logged', recentLogs({ limit: 500 }).some((l) => l.event === 'jobs.billing_halt'));

jobs.stop();
console.log(failures === 0 ? '\n[smoke] ALL PASS ✅' : `\n[smoke] ${failures} FAILURE(S) ❌`);
process.exit(failures === 0 ? 0 : 1);

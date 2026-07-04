// server.js — Phantom 2.0 backend (Phase 0: foundation).
//
// What exists at this phase: operator auth + coming-soon gate (ported from v1),
// the jobs queue spine, the user-journey events stream, the LLM boundary
// (mock | claude_code | anthropic_api), storage (local | r2), and the operator
// console shell. Funnel/scraper/generation arrive in Phases 1-4.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { nanoid } from 'nanoid';

import { db, adminSessions, events, costEvents } from './lib/db.js';
import * as jobsWorker from './lib/jobs.js';
import { storage } from './lib/storage.js';
import { llm } from './lib/llm.js';
import { logEvent, recentLogs } from './lib/logs.js';
import { readAdminFromCookie, requireAdmin, requireAdminPage } from './middleware/requireAdmin.js';
import adminAuthRoutes from './admin/auth-routes.js';
import { registerScrapeJobs, startIntake } from './lib/scrape/runner.js';
import { intakes, scrapeSources, tenants, purchases, phantoms, campaigns, pieces } from './lib/db.js';
import { registerScriptGenJobs } from './lib/scriptgen/index.js';
import { registerMediaJobs, generateMedia, estimateForIntake, onFalWebhook } from './lib/media/render.js';
import { mediaAssets, audioTracks } from './lib/db.js';
import { registerEditJobs } from './lib/edit/assemble.js';
import { registerComposeJobs } from './lib/edit/post-compose.js';
import { ffmpegAvailable } from './lib/edit/audio.js';
import { applyVerdict, phantomVerdict, REASON_TAGS, REGEN_CAP } from './lib/qc.js';
import { coverageReport } from './lib/coverage.js';
import { rollup as qcRollup, summarizeLearnings } from './lib/qc-learnings.js';
import { connectTenant, deploySchedule, registerDeployJobs } from './lib/deploy/index.js';
import { registerTrackerJobs, runMonthEndReport } from './lib/tracker/index.js';
import { deployments, reports, socialConnections } from './lib/db.js';
import { importTenantBundle } from './lib/promote.js';
import { createRequire } from 'module';
const archiver = createRequire(import.meta.url)('archiver'); // CJS pkg, no ESM default
import { registerValuePropJobs } from './lib/valueprop.js';
import { registerEmailJobs } from './lib/email.js';
import { createCheckout, markIntakePaid, verifyStripeSignature, handleStripeEvent, paymentsMode } from './lib/payments.js';
import { TIERS, TIER_CONFIG, TIER_DISPLAY, isValidTier } from './lib/tiers.js';
import { isEntitled } from './lib/entitlement.js';
import { readUserFromCookie, requireUserOrAdmin } from './middleware/requireUser.js';
import googleAuthRoutes from './auth/google-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const BOOT_TS = Date.now();

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // CSP tightened when the funnel pages land
// Stripe webhook needs the RAW body for signature verification — mount before express.json.
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ── public endpoints (always reachable) ──────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/version', (_req, res) => res.json({
  version: pkg.version,
  sha: process.env.GIT_SHA || null,
}));

// ── user-journey events beacon (public — tracks the anonymous funnel too) ────
// v1 recorded nothing about what users did; every page/action now lands here.
// The same stream later drives agent-email stage triggers.
const SID_COOKIE = 'ph_sid';
const eventsLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: false, legacyHeaders: false });
app.post('/api/events', eventsLimiter, (req, res) => {
  try {
    const { name, path: pagePath = null, props = null, tenant = null } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ success: false, error: 'name required' });
    let sid = req.cookies?.[SID_COOKIE];
    if (!sid) {
      sid = nanoid(21);
      res.cookie(SID_COOKIE, sid, {
        httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1',
        maxAge: 180 * 86400 * 1000, path: '/',
      });
    }
    events.record({
      sessionKey: sid, tenantSlug: tenant, name, path: pagePath,
      props: props && typeof props === 'object' ? props : null,
      ip: req.ip || null, userAgent: req.get('user-agent') || null,
    });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── fal webhook — accelerates the matching queued poll job (single execution
// path lives in the poller; a webhook can never double-ingest).
app.post('/webhook/fal', (req, res) => {
  const requestId = req.body?.request_id || null;
  const accelerated = requestId ? onFalWebhook(requestId) : 0;
  logEvent({ event: 'fal.webhook', provider: 'fal', refId: requestId, message: `accelerated ${accelerated} poll(s)`, meta: { status: req.body?.status || null } });
  res.json({ ok: true, accelerated });
});

// ── stripe webhook (raw body; signature-verified when a secret is set) ───────
app.post('/webhook/stripe', (req, res) => {
  try {
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body);
    const sig = verifyStripeSignature(raw, req.get('stripe-signature'));
    if (!sig.ok) {
      logEvent({ level: 'warn', event: 'stripe.webhook_rejected', message: sig.error });
      return res.status(400).json({ success: false, error: sig.error });
    }
    if (sig.unsigned) logEvent({ level: 'warn', event: 'stripe.webhook_unsigned', message: 'STRIPE_WEBHOOK_SECRET not set — accepting unsigned (dev only)' });
    const result = handleStripeEvent(JSON.parse(raw));
    res.json({ received: true, ...result });
  } catch (err) {
    logEvent({ level: 'error', event: 'stripe.webhook_error', message: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── local-storage streamer (STORAGE_BACKEND=local signed URLs resolve here) ──
app.get('/api/media/local/:token', (req, res) => {
  const hit = storage._readLocal(req.params.token);
  if (!hit) return res.status(404).json({ success: false, error: 'expired or unknown media token' });
  res.setHeader('Content-Type', hit.contentType);
  fs.createReadStream(hit.path).pipe(res);
});

// ── COMING_SOON gate (ported v1 behavior) ────────────────────────────────────
// Public sees only the coming-soon page (+ allowlist); operators pass everywhere.
const GATE_ALLOW = [
  '/health', '/version', '/admin/auth/', '/app/admin-login.html', '/app/assets/',
  '/privacy.html', '/terms.html', '/webhook/', '/api/events', '/api/media/local/',
  '/favicon.ico',
];
app.use((req, res, next) => {
  if (process.env.COMING_SOON !== '1') return next();
  if (GATE_ALLOW.some((p) => req.path === p || req.path.startsWith(p))) return next();
  if (readAdminFromCookie(req)) return next();
  if (req.path.startsWith('/api/') || req.method !== 'GET') {
    return res.status(503).json({ success: false, error: 'coming soon' });
  }
  return res.sendFile(path.join(__dirname, 'public', 'coming-soon.html'));
});

// ── operator auth + console ──────────────────────────────────────────────────
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30, standardHeaders: false, legacyHeaders: false });
app.use('/admin/auth', loginLimiter, adminAuthRoutes);
app.use('/auth/google', googleAuthRoutes);   // includes POST /auth/google/logout

// ── funnel APIs — registered AFTER the gate on purpose: under COMING_SOON=1
// only operators reach these (no anonymous scrape/LLM spend); at launch
// (COMING_SOON=0) they are public. /webhook/* and /api/events stay allowlisted.
const intakeLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, standardHeaders: false, legacyHeaders: false });
app.post('/api/intake', intakeLimiter, (req, res) => {
  try {
    const { business_name, website } = req.body || {};
    if (!business_name || !website) return res.status(400).json({ success: false, error: 'business_name and website required' });
    const { intake, tenant } = startIntake({ businessName: String(business_name).slice(0, 120), website: String(website).slice(0, 300) });
    res.json({ success: true, intake_id: intake.id, tenant_slug: tenant.slug });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/intake/:id/status', (req, res) => {
  const intake = intakes.byId(req.params.id);
  if (!intake) return res.status(404).json({ success: false, error: 'not found' });
  res.json({
    success: true,
    id: intake.id,
    business_name: intake.business_name,
    status: intake.status,
    value_prop: intake.value_prop ? JSON.parse(intake.value_prop) : null,
    plan: intake.plan,
    payment_status: intake.payment_status,
    entitled: isEntitled(intake),
    claimed: !!intake.claimed_user_id,
  });
});

app.post('/api/intake/:id/plan', (req, res) => {
  const intake = intakes.byId(req.params.id);
  if (!intake) return res.status(404).json({ success: false, error: 'not found' });
  const plan = String(req.body?.plan || '');
  if (!isValidTier(plan)) return res.status(400).json({ success: false, error: `plan must be one of ${TIERS.join('|')}` });
  intakes.patch(intake.id, { plan });
  events.record({ tenantSlug: intake.tenant_slug, name: 'plan.selected', props: { intakeId: intake.id, plan } });
  res.json({ success: true, plan });
});

// Checkout requires an identity: a Google-signed customer OR the operator (demo path).
app.post('/api/intake/:id/checkout', requireUserOrAdmin, async (req, res) => {
  try {
    const intake = intakes.byId(req.params.id);
    if (!intake) return res.status(404).json({ success: false, error: 'not found' });
    const plan = String(req.body?.plan || intake.plan || '');
    if (!isValidTier(plan)) return res.status(400).json({ success: false, error: 'select a plan first' });
    if (isEntitled(intake)) return res.json({ success: true, already_paid: true, url: `/app/checkout-success.html?intake=${intake.id}` });
    if (plan !== intake.plan) intakes.patch(intake.id, { plan });
    const baseUrl = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const session = await createCheckout({ intake: intakes.byId(intake.id), plan, baseUrl });
    events.record({ tenantSlug: intake.tenant_slug, name: 'checkout.started', props: { intakeId: intake.id, plan, mock: !!session.mock } });
    res.json({ success: true, url: session.url, mock: !!session.mock });
  } catch (err) {
    logEvent({ level: 'error', event: 'checkout.error', message: err.message });
    res.status(502).json({ success: false, error: err.message });
  }
});

// Mock-mode completion: checkout-success lands with ?mock=1 → confirm here.
app.post('/api/intake/:id/mock-pay', requireUserOrAdmin, (req, res) => {
  if (paymentsMode() !== 'mock') return res.status(400).json({ success: false, error: 'not in mock payments mode' });
  const intake = markIntakePaid(req.params.id, { via: 'mock', sessionId: req.body?.session || null });
  res.json({ success: true, payment_status: intake.payment_status });
});

app.get('/api/tiers', (_req, res) => {
  res.json({ success: true, tiers: TIERS.map((t) => ({ key: t, ...TIER_CONFIG[t], ...TIER_DISPLAY[t] })) });
});

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    google_oauth: !!process.env.GOOGLE_CLIENT_ID,
    payments_mode: paymentsMode(),
    is_admin: !!readAdminFromCookie(req),
  });
});

app.get('/api/me', (req, res) => {
  const user = readUserFromCookie(req);
  if (!user) return res.status(401).json({ success: false, error: 'no session' });
  res.json({ success: true, user });
});


// Admin HTML pages need a session even when COMING_SOON=0 (login page excepted).
app.use((req, res, next) => {
  if (req.path === '/app/admin.html') return requireAdminPage(req, res, next);
  next();
});

app.get('/api/admin/status', requireAdmin, (_req, res) => {
  res.json({
    success: true,
    version: pkg.version,
    uptime_sec: Math.floor((Date.now() - BOOT_TS) / 1000),
    claude_mode: llm.mode,
    llm_models: llm.models,
    storage_backend: storage.backend,
    mock_media_gen: process.env.MOCK_MEDIA_GEN === '1',
    coming_soon: process.env.COMING_SOON === '1',
  });
});

app.get('/api/admin/jobs/summary', requireAdmin, (_req, res) => {
  res.json({ success: true, jobs: jobsWorker.summary() });
});

app.get('/api/admin/events/summary', requireAdmin, (req, res) => {
  const hours = Math.min(parseInt(req.query.hours || '24', 10) || 24, 24 * 30);
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  res.json({
    success: true,
    hours,
    counts: events.countsSince(since),
    recent: events.recent(parseInt(req.query.limit || '50', 10) || 50),
  });
});

app.get('/api/admin/events/session/:sid', requireAdmin, (req, res) => {
  res.json({ success: true, events: events.bySession(req.params.sid) });
});

app.get('/api/admin/costs/summary', requireAdmin, (req, res) => {
  const hours = Math.min(parseInt(req.query.hours || '24', 10) || 24, 24 * 30);
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  res.json({ success: true, hours, totals: costEvents.totalsSince(since) });
});

app.get('/api/admin/logs', requireAdmin, (req, res) => {
  res.json({ success: true, logs: recentLogs({ tenant: req.query.tenant || null, limit: req.query.limit || 100 }) });
});

// ── Phase 1: Agent-Scraper sandbox (admin-gated until the Phase-2 funnel) ────
app.post('/api/admin/intake', requireAdmin, (req, res) => {
  try {
    const { business_name, website } = req.body || {};
    if (!business_name || !website) return res.status(400).json({ success: false, error: 'business_name and website required' });
    const { intake, tenant } = startIntake({ businessName: String(business_name).slice(0, 120), website: String(website).slice(0, 300) });
    res.json({ success: true, intake, tenant });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/intakes', requireAdmin, (_req, res) => {
  const list = intakes.list(50).map((i) => ({ ...i, sources: scrapeSources.byIntake(i.id) }));
  res.json({ success: true, intakes: list });
});

// Admin override (BPMN requirement): skip OAuth + Stripe, unlock the rest of the
// funnel/pipeline exactly as a paid customer would experience it.
app.post('/api/admin/intake/:id/override', requireAdmin, (req, res) => {
  try {
    const plan = isValidTier(req.body?.plan) ? req.body.plan : 'premium';
    const intake = markIntakePaid(req.params.id, { via: 'admin_override', plan });
    res.json({ success: true, intake, entitled: isEntitled(intake) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Phase 3: production view + sandbox script-gen ("choose the amount of reels I
// want to produce and for what brand" — counts override the plan; regenerate wipes+rebuilds).
app.post('/api/admin/intake/:id/scriptgen', requireAdmin, (req, res) => {
  const intake = intakes.byId(req.params.id);
  if (!intake) return res.status(404).json({ success: false, error: 'not found' });
  if (!intake.scrape_key) return res.status(400).json({ success: false, error: 'scrape has not completed yet' });
  const { reels = null, posts = null, regenerate = false } = req.body || {};
  const jobId = jobsWorker.enqueue({
    kind: 'script_gen', tenantSlug: intake.tenant_slug, refKind: 'intake', refId: intake.id,
    payload: {
      intakeId: intake.id,
      reels: Number.isInteger(reels) && reels > 0 ? Math.min(reels, 200) : null,
      posts: Number.isInteger(posts) && posts > 0 ? Math.min(posts, 300) : null,
      regenerate: !!regenerate,
    },
    maxAttempts: 2,
  });
  res.json({ success: true, job_id: jobId });
});

// Phase 4: media generation — explicit, estimated, never auto (v1 spend lesson).
app.get('/api/admin/intake/:id/media-estimate', requireAdmin, (req, res) => {
  try { res.json({ success: true, estimate: estimateForIntake(req.params.id) }); }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.post('/api/admin/intake/:id/generate-media', requireAdmin, (req, res) => {
  try {
    const { phantoms: doPhantoms = true, reels = 'all', posts = 'all' } = req.body || {};
    const kicked = generateMedia({ intakeId: req.params.id, doPhantoms, reels, posts });
    res.json({ success: true, kicked, estimate: estimateForIntake(req.params.id) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── QC (Phase 6): flag → regen (max 3), verdicts feed brand learnings ────────
app.post('/api/admin/piece/:id/qc', requireAdmin, (req, res) => {
  try {
    const { verdict, reason_text = null, reason_tags = null } = req.body || {};
    const result = applyVerdict({
      pieceId: parseInt(req.params.id, 10), verdict,
      reasonText: reason_text, reasonTags: reason_tags, actor: 'operator',
    });
    res.json({ success: true, ...result, reason_tags_allowed: REASON_TAGS, cap: REGEN_CAP });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/phantom/:id/qc', requireAdmin, (req, res) => {
  try {
    const { verdict, reason_text = null } = req.body || {};
    const result = phantomVerdict({ phantomId: parseInt(req.params.id, 10), verdict, reasonText: reason_text });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/intake/:id/coverage', requireAdmin, (req, res) => {
  try { res.json({ success: true, report: coverageReport(req.params.id) }); }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/admin/tenant/:slug/learnings', requireAdmin, async (req, res) => {
  res.json({ success: true, rollup: qcRollup(req.params.slug), bullets: await summarizeLearnings(req.params.slug) });
});

// ── journey funnel (Phase 8) — stage conversion across distinct sessions ─────
const FUNNEL_STAGES = ['page.index', 'intake.submitted', 'scrape.completed', 'proposal.viewed', 'plan.selected', 'checkout.started', 'funnel.paid'];
app.get('/api/admin/funnel', requireAdmin, (req, res) => {
  const hours = Math.min(parseInt(req.query.hours || '168', 10) || 168, 24 * 90);
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const stages = events.funnel(FUNNEL_STAGES, since);
  const withConversion = stages.map((s, i) => ({
    ...s,
    pct_of_top: stages[0].sessions ? Math.round((s.sessions / stages[0].sessions) * 100) : 0,
    drop_from_prev: i > 0 && stages[i - 1].sessions ? Math.round((1 - s.sessions / stages[i - 1].sessions) * 100) : 0,
  }));
  res.json({ success: true, hours, funnel: withConversion });
});

// ── gallery + ZIP delivery (Phase 8) — the Standard-tier path, and every
// tier's review surface. Admin or the claiming customer can view/download.
function canViewIntake(req, intake) {
  if (readAdminFromCookie(req)) return true;
  const user = readUserFromCookie(req);
  return !!(user && intake.org_id && user.orgId === intake.org_id);
}

app.get('/api/intake/:id/gallery', (req, res) => {
  const intake = intakes.byId(req.params.id);
  if (!intake) return res.status(404).json({ success: false, error: 'not found' });
  if (!canViewIntake(req, intake)) return res.status(403).json({ success: false, error: 'forbidden' });
  const finals = { reel: 'reel', post: 'post_final' };
  const items = pieces.byIntake(intake.id)
    .filter((p) => ['ready', 'approved'].includes(p.status))
    .map((p) => {
      const asset = mediaAssets.byRef('piece', p.id).find((a) => a.kind === finals[p.kind]);
      const brief = JSON.parse(p.brief);
      return asset ? {
        piece_id: p.id, kind: p.kind, status: p.status, scheduled_date: p.scheduled_date,
        caption: brief.caption || null, asset_id: asset.id, content_type: asset.content_type,
      } : null;
    }).filter(Boolean);
  res.json({ success: true, business_name: intake.business_name, items });
});

// Customer-reachable signed media (gallery previews) — same view guard.
app.get('/api/intake/:id/media/:assetId', async (req, res) => {
  const intake = intakes.byId(req.params.id);
  if (!intake) return res.status(404).json({ success: false, error: 'not found' });
  if (!canViewIntake(req, intake)) return res.status(403).json({ success: false, error: 'forbidden' });
  const asset = mediaAssets.byId(parseInt(req.params.assetId, 10));
  if (!asset || asset.tenant_slug !== intake.tenant_slug || asset.status !== 'active') {
    return res.status(404).json({ success: false, error: 'not found' });
  }
  res.redirect(302, await storage.signedGet(asset.tenant_slug, asset.r2_key, 600));
});

app.get('/api/intake/:id/download.zip', async (req, res) => {
  const intake = intakes.byId(req.params.id);
  if (!intake) return res.status(404).json({ success: false, error: 'not found' });
  if (!canViewIntake(req, intake)) return res.status(403).json({ success: false, error: 'forbidden' });
  const finals = { reel: 'reel', post: 'post_final' };
  const entries = [];
  for (const p of pieces.byIntake(intake.id).filter((x) => ['ready', 'approved'].includes(x.status))) {
    const asset = mediaAssets.byRef('piece', p.id).find((a) => a.kind === finals[p.kind]);
    if (asset) entries.push({ piece: p, asset });
  }
  if (!entries.length) return res.status(404).json({ success: false, error: 'nothing ready to download yet' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="phantom-${intake.tenant_slug}.zip"`);
  const zip = archiver('zip', { zlib: { level: 1 } });   // media is pre-compressed
  zip.on('error', (err) => { logEvent({ level: 'error', event: 'zip.error', message: err.message }); try { res.destroy(); } catch {} });
  zip.pipe(res);
  const localRoot = storage.localRoot;
  for (const { piece, asset } of entries) {
    const ext = asset.content_type === 'video/mp4' ? 'mp4' : 'png';
    const name = `${piece.scheduled_date}_${piece.kind}_${piece.id}.${ext}`;
    if (storage.backend === 'local') {
      zip.file(path.join(localRoot, asset.r2_key), { name });
    } else {
      const url = await storage.signedGet(asset.tenant_slug, asset.r2_key, 600);
      const r = await fetch(url);
      zip.append(Buffer.from(await r.arrayBuffer()), { name });
    }
  }
  events.record({ tenantSlug: intake.tenant_slug, name: 'gallery.zip_downloaded', props: { intakeId: intake.id, files: entries.length } });
  await zip.finalize();
});

// ── promote-to-prod import pair (Phase 8) — receives a local bundle + files ──
app.post('/api/admin/import/tenant', requireAdmin, express.json({ limit: '50mb' }), (req, res) => {
  try {
    res.json({ success: true, ...importTenantBundle(req.body) });
  } catch (err) {
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/import/media', requireAdmin,
  express.raw({ type: '*/*', limit: '200mb' }),
  async (req, res) => {
    try {
      const key = String(req.query.key || '');
      const m = key.match(/^tenants\/([a-z0-9_-]+)\//);
      if (!m) return res.status(400).json({ success: false, error: 'key must be tenant-prefixed' });
      if (!req.body?.length) return res.status(400).json({ success: false, error: 'empty body' });
      await storage.put(m[1], key, req.body, req.get('content-type') || 'application/octet-stream');
      res.json({ success: true, key, bytes: req.body.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

// ── deploy + tracker (Phase 7) ────────────────────────────────────────────────
app.post('/api/admin/intake/:id/connect', requireAdmin, async (req, res) => {
  try {
    const intake = intakes.byId(req.params.id);
    if (!intake) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, ...(await connectTenant(intake.tenant_slug)) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/intake/:id/deploy', requireAdmin, (req, res) => {
  try {
    const { platforms = null, piece_ids = null } = req.body || {};
    res.json({ success: true, ...deploySchedule({ intakeId: req.params.id, platforms, pieceIds: piece_ids }) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/intake/:id/deployments', requireAdmin, (req, res) => {
  const intake = intakes.byId(req.params.id);
  if (!intake) return res.status(404).json({ success: false, error: 'not found' });
  res.json({
    success: true,
    connection: socialConnections.get(intake.tenant_slug),
    deployments: deployments.byIntake(intake.id).map((d) => ({ ...d, platforms: JSON.parse(d.platforms) })),
  });
});

app.post('/api/admin/tenant/:slug/track', requireAdmin, (req, res) => {
  const jobId = jobsWorker.enqueue({ kind: 'track_metrics', tenantSlug: req.params.slug, payload: { tenantSlug: req.params.slug }, maxAttempts: 2 });
  res.json({ success: true, job_id: jobId });
});

app.post('/api/admin/tenant/:slug/month-end', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, ...(await runMonthEndReport({ tenantSlug: req.params.slug, period: req.body?.period || null })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/tenant/:slug/report/latest', requireAdmin, (req, res) => {
  const r = reports.latest(req.params.slug);
  res.json({ success: true, report: r ? { ...r, summary: JSON.parse(r.summary) } : null });
});

// ── audio library (Phase 5) — the operator's rights-cleared track pool. Raw-body
// upload (no multer dep): POST the mp3 bytes with metadata in the query string.
app.post('/api/admin/audio', requireAdmin,
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }),
  async (req, res) => {
    try {
      const { title, artist = null, license = null, vibe = '' } = req.query;
      if (!title) return res.status(400).json({ success: false, error: 'title query param required' });
      if (!req.body?.length) return res.status(400).json({ success: false, error: 'empty body — send the mp3 bytes' });
      const key = storage.makeKey('library', 'audio', 'mp3');
      await storage.put('library', key, req.body, 'audio/mpeg');
      const id = audioTracks.add({
        title: String(title).slice(0, 120), artist, source: 'operator_upload',
        licenseNote: license, r2Key: key,
        vibeTags: String(vibe).split(',').map((s) => s.trim()).filter(Boolean),
      });
      logEvent({ event: 'audio.track_added', refId: id, message: `${title} (${req.body.length} bytes)` });
      res.json({ success: true, id, r2_key: key });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

app.get('/api/admin/audio', requireAdmin, async (_req, res) => {
  res.json({ success: true, tracks: audioTracks.list(), ffmpeg: await ffmpegAvailable() });
});

// Signed-URL redirect for any media asset (console thumbnails/players).
app.get('/api/admin/media/:assetId/url', requireAdmin, async (req, res) => {
  const asset = mediaAssets.byId(parseInt(req.params.assetId, 10));
  if (!asset || asset.status !== 'active') return res.status(404).json({ success: false, error: 'not found' });
  try {
    const url = await storage.signedGet(asset.tenant_slug, asset.r2_key, 600);
    res.redirect(302, url);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/intake/:id/production', requireAdmin, (req, res) => {
  const intake = intakes.byId(req.params.id);
  if (!intake) return res.status(404).json({ success: false, error: 'not found' });
  const pieceRows = pieces.byIntake(intake.id).map((p) => ({ ...p, brief: JSON.parse(p.brief) }));
  // media asset ids per piece/phantom (console links via /api/admin/media/:id/url)
  const assetsByPiece = {};
  const assetsByPhantom = {};
  for (const a of mediaAssets.byTenant(intake.tenant_slug, 2000)) {
    const meta = a.meta ? JSON.parse(a.meta) : {};
    if (a.ref_kind === 'piece' && meta.stage !== 'keyframe') (assetsByPiece[a.ref_id] ||= []).push({ id: a.id, kind: a.kind });
    if (a.kind === 'shot' && meta.source_piece_id) (assetsByPiece[meta.source_piece_id] ||= []).push({ id: a.id, kind: 'shot', slot: meta.slot });
    if (a.ref_kind === 'phantom') assetsByPhantom[a.ref_id] = a.id;
  }
  res.json({
    success: true,
    intake: { id: intake.id, business_name: intake.business_name, tenant_slug: intake.tenant_slug, plan: intake.plan, payment_status: intake.payment_status },
    phantoms: phantoms.byTenant(intake.tenant_slug).filter((p) => p.intake_id === intake.id)
      .map((p) => ({ ...p, asset_id: assetsByPhantom[String(p.id)] || null })),
    campaigns: campaigns.byIntake(intake.id).map((c) => ({ ...c, product_refs: JSON.parse(c.product_refs || '[]') })),
    pieces: pieceRows.map((p) => ({ ...p, assets: assetsByPiece[String(p.id)] || [] })),
    counts: pieces.countByIntake(intake.id),
    calendar: pieces.calendar(intake.id),
  });
});

app.get('/api/admin/intake/:id', requireAdmin, async (req, res) => {
  const intake = intakes.byId(req.params.id);
  if (!intake) return res.status(404).json({ success: false, error: 'not found' });
  let scrapeUrl = null;
  if (intake.scrape_key) {
    try { scrapeUrl = await storage.signedGet(intake.tenant_slug, intake.scrape_key, 600); } catch { /* signed URL best-effort */ }
  }
  res.json({
    success: true, intake,
    tenant: tenants.bySlug(intake.tenant_slug),
    sources: scrapeSources.byIntake(intake.id),
    scrape_url: scrapeUrl,
  });
});

// ── static (v1 caching lesson: HTML/JS/CSS ship no-cache so deploys are live) ─
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, fp) {
    if (/\.(html|js|css)$/.test(fp)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'coming-soon.html')));

// ── errors ────────────────────────────────────────────────────────────────────
app.use('/api', (_req, res) => res.status(404).json({ success: false, error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logEvent({ level: 'error', event: 'http.error', message: err.message, meta: { path: req.path } });
  if (res.headersSent) return;
  res.status(500).json({ success: false, error: 'internal error' });
});

// ── boot ──────────────────────────────────────────────────────────────────────
registerScrapeJobs();
registerValuePropJobs();
registerEmailJobs();
registerScriptGenJobs();
registerMediaJobs();
registerEditJobs();
registerComposeJobs();
registerDeployJobs();
registerTrackerJobs();
jobsWorker.start();
setInterval(() => { try { adminSessions.purgeExpired(); } catch {} }, 3600_000).unref();

const PORT = parseInt(process.env.PORT || '3020', 10);
app.listen(PORT, () => {
  console.log(`[phantom2] v${pkg.version} listening on :${PORT}`);
  console.log(`[phantom2] CLAUDE_MODE=${llm.mode} (spends_credits=${llm.spends_credits}) storage=${storage.backend} mock_media=${process.env.MOCK_MEDIA_GEN === '1'} coming_soon=${process.env.COMING_SOON === '1'}`);
  if (llm.mode === 'anthropic_api' && !process.env.ANTHROPIC_API_KEY) {
    console.warn('[warn] CLAUDE_MODE=anthropic_api but ANTHROPIC_API_KEY is not set — Claude calls will fail.');
  }
});

export default app;

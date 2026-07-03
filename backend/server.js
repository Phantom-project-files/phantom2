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
import { intakes, scrapeSources, tenants, purchases } from './lib/db.js';
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

// ── fal webhook (Phase 4 wires this to the jobs table; stub logs + 200s now) ─
app.post('/webhook/fal', (req, res) => {
  logEvent({ event: 'fal.webhook', provider: 'fal', refId: req.body?.request_id || null, meta: { status: req.body?.status || null } });
  res.json({ ok: true });
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

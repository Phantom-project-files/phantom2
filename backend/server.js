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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const BOOT_TS = Date.now();

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // CSP tightened when the funnel pages land
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

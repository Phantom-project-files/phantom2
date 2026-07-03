// Phase 1 (plan.md): /admin/auth/* routes.
//
//   POST /admin/auth/login          { email, password }            → sets phantom_admin cookie
//   POST /admin/auth/logout         (cookie)                        → destroys session
//   GET  /admin/auth/me             (cookie)                        → { admin }
//   POST /admin/auth/invite         (cookie, role=owner|admin)      → { invite_url }
//   POST /admin/auth/accept-invite  { token, password, name? }      → sets cookie
//   GET  /admin/auth/list           (cookie, owner)                 → admins[]
//
// All session ids are 32 random bytes base64url'd → 43 chars. Cookies are
// HttpOnly + SameSite=Lax + Secure when COOKIE_SECURE=1.

import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { admins, adminSessions } from '../lib/db.js';
import { requireAdmin, requireRole, ADMIN_COOKIE } from '../middleware/requireAdmin.js';
import { logEvent } from '../lib/logs.js';

const router = Router();

const SESSION_TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS || '30', 10);
const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 86400;
const INVITE_TTL_HOURS = parseInt(process.env.ADMIN_INVITE_TTL_HOURS || '72', 10);
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;   // omit → host-only
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const BCRYPT_ROUNDS = 12;

// 0.0.1 (private beta): a single hardcoded operator, credentials from env.
// Short passwords are fine here — this is one known operator behind the login
// rate-limiter, NOT a public signup — so there is no 12-char minimum on this path.
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const HARDCODED_ADMIN_EMAIL = (process.env.ADMIN_EMAIL
  || (ADMIN_USERNAME ? `${ADMIN_USERNAME}@phantom.local` : 'operator@phantom.local')).toLowerCase();

// Length-guarded timing-safe compare — avoids leaking the password via early-exit timing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// 0.0.3: per-account failed-login throttle — complements the per-IP loginLimiter so an
// attacker rotating IPs is still capped per username. In-memory; fine single-instance.
const _loginFails = new Map();   // idKey -> { n, resetAt }
const FAIL_MAX = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
function loginBlocked(idKey) {
  const r = _loginFails.get(idKey);
  return !!(r && r.resetAt > Date.now() && r.n >= FAIL_MAX);
}
function recordLoginFail(idKey) {
  const r = _loginFails.get(idKey);
  if (!r || r.resetAt <= Date.now()) _loginFails.set(idKey, { n: 1, resetAt: Date.now() + FAIL_WINDOW_MS });
  else r.n++;
}
function clearLoginFails(idKey) { _loginFails.delete(idKey); }

function newSessionId() {
  return crypto.randomBytes(32).toString('base64url');
}

function newInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function setAdminCookie(res, sid) {
  res.cookie(ADMIN_COOKIE, sid, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  });
}

function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  });
}

function inviteUrlFor(token, req) {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/app/admin-accept-invite.html?token=${encodeURIComponent(token)}`;
}

function publicAdminShape(admin) {
  return {
    id: admin.id, email: admin.email, name: admin.name, role: admin.role,
    status: admin.status, last_login_at: admin.last_login_at,
  };
}

// ── POST /login ─────────────────────────────────────────────────────────────
// Accepts { username | email, password }. Two paths:
//   1. Hardcoded single operator (0.0.1): ADMIN_USERNAME/ADMIN_PASSWORD env. On a
//      match we upsert an *active* admins row (bcrypt) so all the session/cookie/
//      guard machinery downstream is unchanged, then mint a session.
//   2. Fallback: the invite-based admins table (email + bcrypt), kept intact.
router.post('/login', async (req, res) => {
  try {
    const { email, username, password } = req.body || {};
    const ident = String(username || email || '').trim();
    if (!ident || !password) {
      return res.status(400).json({ success: false, error: 'username and password required' });
    }
    const idKey = ident.toLowerCase();
    if (loginBlocked(idKey)) {
      return res.status(429).json({ success: false, error: 'too many attempts — wait 15 minutes' });
    }

    // Path 1 — hardcoded env operator.
    if (ADMIN_USERNAME && ADMIN_PASSWORD
        && ident.toLowerCase() === ADMIN_USERNAME.toLowerCase()
        && safeEqual(password, ADMIN_PASSWORD)) {
      const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
      const row = admins.ensureActive({
        email: HARDCODED_ADMIN_EMAIL, name: ADMIN_USERNAME, role: 'owner', passwordHash,
      });
      const sid = newSessionId();
      adminSessions.create({
        id: sid, adminId: row.id, ttlSeconds: SESSION_TTL_SECONDS,
        ip: req.ip || null, userAgent: req.get('user-agent') || null,
      });
      admins.touchLogin(row.id);
      setAdminCookie(res, sid);
      clearLoginFails(idKey);
      logEvent({ event: 'admin.login', message: `operator ${ident} signed in`, meta: { ip: req.ip } });
      return res.json({ success: true, admin: publicAdminShape(row) });
    }

    // Path 2 — invite-based admins (email + bcrypt). Constant-time-ish on unknown email
    // so timing doesn't reveal account existence (the dummy hash matches no password).
    const row = admins.byEmail(ident.toLowerCase());
    const DUMMY_HASH = '$2a$12$0000000000000000000000000000000000000000000000000000';
    const hash = row?.password_hash || DUMMY_HASH;
    const ok = await bcrypt.compare(String(password), hash);
    if (!row || row.status !== 'active' || !row.password_hash || !ok) {
      recordLoginFail(idKey);
      return res.status(401).json({ success: false, error: 'invalid credentials' });
    }

    const sid = newSessionId();
    adminSessions.create({
      id: sid, adminId: row.id, ttlSeconds: SESSION_TTL_SECONDS,
      ip: req.ip || null, userAgent: req.get('user-agent') || null,
    });
    admins.touchLogin(row.id);
    setAdminCookie(res, sid);
    clearLoginFails(idKey);
    res.json({ success: true, admin: publicAdminShape(row) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /logout ────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const sid = req.cookies?.[ADMIN_COOKIE];
  if (sid) {
    try { adminSessions.destroy(sid); } catch { /* no-op */ }
  }
  clearAdminCookie(res);
  res.json({ success: true });
});

// ── GET /me ─────────────────────────────────────────────────────────────────
router.get('/me', requireAdmin, (req, res) => {
  res.json({ success: true, admin: req.admin });
});

// ── POST /invite ────────────────────────────────────────────────────────────
// Owners may invite admin/viewer. Admins may invite viewer only.
router.post('/invite', requireAdmin, async (req, res) => {
  try {
    const { email, role = 'admin', name = null } = req.body || {};
    if (!email) return res.status(400).json({ success: false, error: 'email required' });
    const targetRole = String(role).toLowerCase();
    if (!['owner', 'admin', 'viewer'].includes(targetRole)) {
      return res.status(400).json({ success: false, error: 'role must be owner|admin|viewer' });
    }
    if (req.admin.role !== 'owner' && targetRole !== 'viewer') {
      return res.status(403).json({ success: false, error: 'only owners may invite owner or admin roles' });
    }

    const lcEmail = String(email).toLowerCase().trim();
    const existing = admins.byEmail(lcEmail);
    if (existing && existing.status === 'active') {
      return res.status(409).json({ success: false, error: 'email already in use' });
    }

    const token = newInviteToken();
    const expiresAt = Math.floor(Date.now() / 1000) + (INVITE_TTL_HOURS * 3600);

    let row;
    if (existing && existing.status === 'invited') {
      // Re-issue invite by writing a new token; simplest is delete+recreate, but UPDATE keeps the id.
      // Inline UPDATE here so the helper surface stays small.
      const reissue = (await import('../lib/db.js')).db.prepare(`
        UPDATE admins SET invite_token = ?, invite_expires = ?, role = ?,
                          invited_by = ?, name = COALESCE(?, name)
                       WHERE id = ?
      `);
      reissue.run(token, expiresAt, targetRole, req.admin.id, name, existing.id);
      row = admins.byId(existing.id);
    } else {
      row = admins.createInvite({
        email: lcEmail, name, role: targetRole, token,
        expiresAt, invitedBy: req.admin.id,
      });
    }

    res.json({
      success: true,
      admin: publicAdminShape(row),
      invite_url: inviteUrlFor(token, req),
      expires_at: expiresAt,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /accept-invite ─────────────────────────────────────────────────────
// PUBLIC route (no requireAdmin) — the invitee doesn't have a session yet.
router.post('/accept-invite', async (req, res) => {
  try {
    const { token, password, name = null } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ success: false, error: 'token and password required' });
    }
    if (String(password).length < 12) {
      return res.status(400).json({ success: false, error: 'password must be at least 12 chars' });
    }
    const row = admins.byInviteToken(String(token));
    if (!row) return res.status(410).json({ success: false, error: 'invite invalid or already used' });
    if (row.invite_expires && row.invite_expires < Math.floor(Date.now() / 1000)) {
      return res.status(410).json({ success: false, error: 'invite expired' });
    }

    const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const ok = admins.acceptInvite(row.id, { passwordHash: hash, name });
    if (!ok) return res.status(410).json({ success: false, error: 'invite no longer valid' });

    const sid = newSessionId();
    adminSessions.create({
      id: sid,
      adminId: row.id,
      ttlSeconds: SESSION_TTL_SECONDS,
      ip: req.ip || null,
      userAgent: req.get('user-agent') || null,
    });
    admins.touchLogin(row.id);
    setAdminCookie(res, sid);
    res.json({ success: true, admin: publicAdminShape(admins.byId(row.id)) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /list (owner-only) ──────────────────────────────────────────────────
router.get('/list', requireAdmin, requireRole('owner'), (_req, res) => {
  res.json({ success: true, admins: admins.list() });
});

export default router;

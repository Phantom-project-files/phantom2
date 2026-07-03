// Phase 1 (plan.md §"Phase 1 — admin auth"): two guards + a cookie reader.
//
//   readAdminFromCookie(req) → { id, email, role, sessionId } | null
//   requireAdmin(req,res,next) → 401 JSON if no valid admin session (for /api/admin/*)
//   requireAdminPage(req,res,next) → 302 to /app/admin-login.html?next=... (for HTML)
//
// Session id lives in the cookie ADMIN_COOKIE_NAME (default 'phantom_admin'). Lookup
// hits admin_sessions; expired or destroyed rows → no session. `touch` is best-effort
// so an expired session doesn't keep itself alive forever (a TTL extension would).

import { adminSessions } from '../lib/db.js';

const ADMIN_COOKIE_NAME = process.env.ADMIN_COOKIE_NAME || 'phantom_admin';
const LOGIN_PATH = '/app/admin-login.html';

export function readAdminFromCookie(req) {
  const sid = req.cookies?.[ADMIN_COOKIE_NAME];
  if (!sid) return null;
  const row = adminSessions.find(sid);
  if (!row) return null;
  // Best-effort touch — failure to update last_seen_at doesn't fail the request.
  try { adminSessions.touch(sid); } catch { /* no-op */ }
  return {
    id: row.admin_id,
    email: row.admin_email,
    name: row.admin_name,
    role: row.admin_role,
    sessionId: row.id,
    expiresAt: row.expires_at,
  };
}

export function requireAdmin(req, res, next) {
  const admin = readAdminFromCookie(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: 'admin session required' });
  }
  req.admin = admin;
  next();
}

// Same logic but redirect-friendly for HTML pages. Preserves the requested path
// in ?next= so post-login bounces back to the page the user originally wanted.
export function requireAdminPage(req, res, next) {
  const admin = readAdminFromCookie(req);
  if (admin) { req.admin = admin; return next(); }
  const next_ = encodeURIComponent(req.originalUrl || req.url);
  return res.redirect(302, `${LOGIN_PATH}?expired=1&next=${next_}`);
}

// requireRole('owner') — wrap requireAdmin's protected handlers.
export function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ success: false, error: 'admin session required' });
    if (!allowed.includes(req.admin.role)) {
      return res.status(403).json({ success: false, error: `requires role: ${allowed.join(' | ')}` });
    }
    next();
  };
}

export const ADMIN_COOKIE = ADMIN_COOKIE_NAME;
export const ADMIN_LOGIN_PATH = LOGIN_PATH;

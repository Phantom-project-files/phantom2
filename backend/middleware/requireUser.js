// middleware/requireUser.js — customer (Google OAuth) session guards.
//   readUserFromCookie(req)   → { id, email, name, orgId, sessionId } | null
//   requireUser               → 401 JSON without a valid session
//   requireUserOrAdmin        → customer OR operator session passes (funnel demo
//                               path: admins walk the funnel without Google creds)

import { userSessions } from '../lib/db.js';
import { readAdminFromCookie } from './requireAdmin.js';

export const USER_COOKIE = process.env.USER_COOKIE_NAME || 'phantom_session';

export function readUserFromCookie(req) {
  const sid = req.cookies?.[USER_COOKIE];
  if (!sid) return null;
  const row = userSessions.find(sid);
  if (!row) return null;
  return { id: row.user_id, email: row.user_email, name: row.user_name, orgId: row.user_org_id, sessionId: row.id };
}

export function requireUser(req, res, next) {
  const user = readUserFromCookie(req);
  if (!user) return res.status(401).json({ success: false, error: 'sign-in required', need_auth: true });
  req.user = user;
  next();
}

export function requireUserOrAdmin(req, res, next) {
  const user = readUserFromCookie(req);
  if (user) { req.user = user; return next(); }
  const admin = readAdminFromCookie(req);
  if (admin) { req.admin = admin; return next(); }
  return res.status(401).json({ success: false, error: 'sign-in required', need_auth: true });
}

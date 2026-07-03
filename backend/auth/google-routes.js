// auth/google-routes.js — Google OAuth (Authorization Code + state cookie).
// v1-ported (plain OIDC: three fetches, no googleapis dep), adapted to the 2.0
// schema: tenants are minted at INTAKE time, so OAuth's job is claiming —
// user ⇄ org ⇄ intake ⇄ tenant — not tenant bootstrap.
//
//   GET /auth/google/start?next=/app/checkout.html?intake=<id>&plan=<tier>
//   GET /auth/google/callback   → upsert user → ensure org → claim intake → session cookie → next
//   POST /auth/logout

import { Router } from 'express';
import crypto from 'crypto';
import { users, userSessions, orgs, intakes, tenants, events, db } from '../lib/db.js';
import { USER_COOKIE } from '../middleware/requireUser.js';
import { logEvent } from '../lib/logs.js';
import { sendEmail } from '../lib/email.js';

const router = Router();

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const STATE_COOKIE = 'phantom_oauth_state';
const STATE_TTL_SECONDS = 600;
const SESSION_TTL_SECONDS = parseInt(process.env.SESSION_TTL_DAYS || '30', 10) * 86400;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

const publicBaseUrl = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const redirectUri = (req) => process.env.GOOGLE_REDIRECT_URI || `${publicBaseUrl(req)}/auth/google/callback`;

function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/app/admin.html';
  return raw;
}

function setStateCookie(res, state, next) {
  const payload = Buffer.from(JSON.stringify({ s: state, n: next, t: Date.now() })).toString('base64url');
  res.cookie(STATE_COOKIE, payload, {
    httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax',   // lax — Google's redirect IS cross-site
    maxAge: STATE_TTL_SECONDS * 1000, path: '/auth/google',
  });
}
function readStateCookie(req) {
  try {
    const d = JSON.parse(Buffer.from(req.cookies?.[STATE_COOKIE] || '', 'base64url').toString('utf8'));
    if (!d?.s || !d?.t || Date.now() - d.t > STATE_TTL_SECONDS * 1000) return null;
    return d;
  } catch { return null; }
}

router.get('/start', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.redirect(302, '/app/signup.html?oauth_error=not_configured' + (req.query.next ? `&next=${encodeURIComponent(req.query.next)}` : ''));
  }
  const state = crypto.randomBytes(32).toString('base64url');
  const next = safeNext(req.query.next);
  setStateCookie(res, state, next);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state, access_type: 'online', prompt: 'select_account',
  });
  res.redirect(302, `${GOOGLE_AUTH_URL}?${params.toString()}`);
});

router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: googleError } = req.query || {};
    if (googleError) {
      res.clearCookie(STATE_COOKIE, { path: '/auth/google' });
      return res.redirect(302, `/app/signup.html?oauth_error=${encodeURIComponent(String(googleError))}`);
    }
    if (!code || !state) return res.status(400).send('missing code or state');
    const cookieState = readStateCookie(req);
    res.clearCookie(STATE_COOKIE, { path: '/auth/google' });
    if (!cookieState) return res.status(400).send('OAuth state cookie missing or expired — try again');
    if (cookieState.s !== state) return res.status(400).send('OAuth state mismatch — refusing');

    const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(req),
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenResp.ok) {
      logEvent({ level: 'error', event: 'oauth.token_failed', message: `HTTP ${tokenResp.status}` });
      return res.status(502).send('OAuth token exchange failed');
    }
    const tokens = await tokenResp.json();
    const userResp = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!userResp.ok) return res.status(502).send('failed to fetch userinfo');
    const profile = await userResp.json();
    if (!profile.sub || !profile.email) return res.status(502).send('userinfo missing sub or email');
    if (profile.email_verified === false) return res.status(403).send('Google email not verified — refusing sign-in');

    const user = users.upsertFromGoogle({ sub: profile.sub, email: profile.email, name: profile.name, picture: profile.picture });

    // Claim: ?next carries /app/checkout.html?intake=<id>...
    let intakeId = null;
    try { intakeId = new URL(cookieState.n, publicBaseUrl(req)).searchParams.get('intake'); } catch {}
    const intake = intakeId ? intakes.byId(intakeId) : null;

    let orgId = user.org_id;
    if (!orgId) {
      const org = orgs.create(intake?.business_name || profile.name || profile.email);
      users.setOrg(user.id, org.id);
      orgId = org.id;
    }
    if (intake && !intake.claimed_user_id) {
      intakes.patch(intake.id, { orgId, claimedUserId: user.id });
      db.prepare('UPDATE tenants SET org_id = ?, status = ? WHERE slug = ?').run(orgId, 'active', intake.tenant_slug);
      events.record({ tenantSlug: intake.tenant_slug, userId: user.id, orgId, name: 'oauth.claimed', props: { intakeId } });
      sendEmail({ intakeId: intake.id, template: 'welcome_claimed', tenantSlug: intake.tenant_slug });
      logEvent({ event: 'oauth.claimed', tenantSlug: intake.tenant_slug, refId: intakeId, message: profile.email });
    }

    const sid = crypto.randomBytes(32).toString('base64url');
    userSessions.create({ id: sid, userId: user.id, ttlSeconds: SESSION_TTL_SECONDS, ip: req.ip || null, userAgent: req.get('user-agent') || null });
    res.cookie(USER_COOKIE, sid, {
      httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax',
      maxAge: SESSION_TTL_SECONDS * 1000, path: '/',
    });
    events.record({ userId: user.id, name: 'oauth.signed_in', props: { new_org: !user.org_id } });
    res.redirect(302, safeNext(cookieState.n));
  } catch (err) {
    logEvent({ level: 'error', event: 'oauth.callback_error', message: err.message });
    res.status(500).send('OAuth callback failed: ' + err.message);
  }
});

router.post('/logout', (req, res) => {
  const sid = req.cookies?.[USER_COOKIE];
  if (sid) { try { userSessions.destroy(sid); } catch {} }
  res.clearCookie(USER_COOKIE, { path: '/' });
  res.json({ success: true });
});

export default router;

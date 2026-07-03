// lib/deploy/ayrshare.js — Ayrshare client (v1 adapter surface, 2.0-slimmed).
//
// Model (Ayrshare Business plan): ONE user profile per tenant, selected by the
// `Profile-Key` header; the customer links their IG/TikTok/YT through Ayrshare's
// hosted connect page (JWT link we mint). Publishing: POST /post with
// scheduleDate — Ayrshare handles the actual timed firing (no cron here).
//
// AYRSHARE_MODE=mock (default when AYRSHARE_API_KEY is unset) → deterministic
// fake profile keys / post ids / analytics so the whole deploy+tracker loop runs $0.

import crypto from 'crypto';
import { logEvent } from '../logs.js';

const API_BASE = process.env.AYRSHARE_BASE || 'https://api.ayrshare.com/api';
const mode = () => (process.env.AYRSHARE_MODE || (process.env.AYRSHARE_API_KEY ? 'live' : 'mock')).toLowerCase();
export const isMock = () => mode() === 'mock';

async function call(path, { method = 'POST', body = null, profileKey = null } = {}) {
  const headers = {
    Authorization: `Bearer ${process.env.AYRSHARE_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (profileKey) headers['Profile-Key'] = profileKey;
  const r = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.status === 'error') {
    const err = new Error(`ayrshare ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.status = r.status;
    err.billing = r.status === 402 || /payment|plan|quota|limit reached/i.test(JSON.stringify(data));
    throw err;
  }
  return data;
}

// One profile per tenant. Returns { profileKey }.
export async function createProfile(tenantSlug) {
  if (isMock()) return { profileKey: `mock-profile-${crypto.createHash('sha1').update(tenantSlug).digest('hex').slice(0, 12)}` };
  const data = await call('/profiles/profile', { body: { title: tenantSlug } });
  return { profileKey: data.profileKey };
}

// Hosted connect page for the customer to link their socials.
export async function connectUrl(profileKey) {
  if (isMock()) return { url: `https://profile.ayrshare.com/mock-connect?key=${profileKey}` };
  const data = await call('/profiles/generateJWT', {
    body: { domain: process.env.AYRSHARE_DOMAIN || 'id-phantom', privateKey: process.env.AYRSHARE_PRIVATE_KEY, profileKey },
  });
  return { url: data.url };
}

// Which platforms the tenant actually linked.
export async function linkedPlatforms(profileKey) {
  if (isMock()) return ['instagram', 'tiktok'];
  const data = await call('/user', { method: 'GET', profileKey });
  return data.activeSocialAccounts || [];
}

// Create/schedule a post. mediaUrls must be publicly fetchable by Ayrshare.
export async function publishPost({ profileKey, caption, mediaUrls, platforms, scheduleDate = null, isVideo = false }) {
  if (isMock()) {
    logEvent({ event: 'ayrshare.post', provider: 'ayrshare', message: `[MOCK] ${platforms.join(',')} ${scheduleDate || 'now'}` });
    return { id: `mock-post-${crypto.randomBytes(6).toString('hex')}`, status: scheduleDate ? 'scheduled' : 'success' };
  }
  const body = {
    post: caption, platforms, mediaUrls,
    ...(isVideo ? { isVideo: true } : {}),
    ...(scheduleDate ? { scheduleDate } : {}),
  };
  const data = await call('/post', { body, profileKey });
  return { id: data.id, status: data.status };
}

// Per-post analytics snapshot.
export async function postAnalytics({ profileKey, postId }) {
  if (isMock()) {
    // deterministic-per-post fake numbers so tests are stable
    const seed = parseInt(crypto.createHash('sha1').update(postId).digest('hex').slice(0, 6), 16);
    return {
      instagram: { views: 500 + (seed % 4500), likes: 40 + (seed % 400), comments: seed % 40, shares: seed % 25 },
    };
  }
  const data = await call('/analytics/post', { body: { id: postId }, profileKey });
  return data;
}

// lib/scrape/social.js — per-platform public-profile probe (Phase 1).
//
// The honest layer of the "better Apify scraper" ask: we ATTEMPT every platform
// with a plain public fetch, classify exactly why it did or didn't work, and
// return an operator-facing status:
//
//   scraped              — public page yielded structured data
//   partial              — page loaded, only fragments extracted
//   blocked_needs_apify  — login wall / JS shell / WAF: this platform needs a
//                          dedicated scraping provider (the flag the operator
//                          asked for: "flag it so I can acquire Apify API")
//   not_found            — 404 on the handle
//   skipped              — offline/fixture mode
//
// No LLM spend here — pure fetch + regex. IG/TikTok/X logged-out are expected
// to land on blocked_needs_apify from a datacenter IP; that's the truthful
// signal, not a failure of this module.

import { fetchPage, detectBlocked, stripTags } from './fetcher.js';

const PROFILE_URL = {
  instagram: (h) => `https://www.instagram.com/${h}/`,
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
  twitter: (h) => `https://x.com/${h}`,
  facebook: (h) => `https://www.facebook.com/${h}`,
  linkedin: (h) => `https://www.linkedin.com/company/${h}/`,
  youtube: (h) => (/^UC[A-Za-z0-9_-]{10,}$/.test(h) ? `https://www.youtube.com/channel/${h}` : `https://www.youtube.com/@${h}`),
  spotify: (h) => `https://open.spotify.com/artist/${h}`,
  soundcloud: (h) => `https://soundcloud.com/${h}`,
};

// Platform-specific nuggets pullable from public HTML when it renders.
function extractProfileBits(platform, html) {
  const bits = {};
  const og = (prop) => (html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]*content=["']([^"']*)["']`, 'i')) || [])[1] || null;
  bits.title = og('title');
  bits.description = og('description');
  bits.image = og('image');
  // follower counts often appear in the og/meta description ("1.2M Followers, …")
  const m = String(bits.description || '').match(/([\d.,]+\s*[KkMm]?)\s*(followers|subscribers)/i);
  if (m) bits.followers_text = m[1];
  if (platform === 'youtube') {
    const subs = html.match(/"subscriberCountText"[^}]*?"([^"]*subscribers?)"/i);
    if (subs) bits.followers_text = subs[1];
  }
  return bits;
}

export async function probePlatform(platform, handle) {
  if (process.env.SCRAPE_OFFLINE === '1') {
    return { platform, handle, status: 'skipped', note: 'offline/fixture mode', data: null };
  }
  const mk = PROFILE_URL[platform];
  if (!mk) return { platform, handle, status: 'skipped', note: 'no prober for platform', data: null };
  const url = mk(handle);
  try {
    const { html, status } = await fetchPage(url, 10000);
    const block = detectBlocked(html, status);
    const bits = extractProfileBits(platform, html);
    const meaningful = bits.description || bits.followers_text;
    if (block.blocked && !meaningful) {
      return { platform, handle, status: 'blocked_needs_apify', note: block.reason, data: null };
    }
    // login-wall heuristic: page rendered but it's a login prompt
    if (/log in|sign up to see|login •/i.test(stripTags(html).slice(0, 600)) && !meaningful) {
      return { platform, handle, status: 'blocked_needs_apify', note: 'login wall', data: null };
    }
    if (meaningful) {
      return {
        platform, handle,
        status: bits.followers_text ? 'scraped' : 'partial',
        note: bits.followers_text ? `public metadata (${bits.followers_text})` : 'og metadata only — deep data (posts/comments/sentiment) needs Apify',
        data: bits,
      };
    }
    return { platform, handle, status: 'blocked_needs_apify', note: 'no extractable public metadata (JS-rendered)', data: null };
  } catch (err) {
    if (err.status === 404) return { platform, handle, status: 'not_found', note: 'profile 404', data: null };
    if (err.status === 403 || err.status === 429) return { platform, handle, status: 'blocked_needs_apify', note: `HTTP ${err.status} (WAF)`, data: null };
    return { platform, handle, status: 'failed', note: err.message, data: null };
  }
}

export async function probeAll(handles) {
  const out = [];
  for (const [platform, handle] of Object.entries(handles || {})) {
    out.push(await probePlatform(platform, handle)); // sequential — polite + low volume
  }
  return out;
}

// lib/scrape/fetcher.js — page fetching + deterministic extraction (Phase 1).
//
// Escalation ladder per the BPMN operator notes ("better Apify scraper …
// if can not create, flag it"):
//   1. plain fetch, real-browser headers   (v1-proven: gets past casual WAFs)
//   2. plain fetch, honest-bot UA          (some WAFs blocklist Chrome UAs from DC IPs)
//   3. → caller flags `blocked_needs_headless` / `blocked_needs_apify` (detectBlocked)
// Headless-Chrome rung arrives with the Phase 5 image (chromium in Docker);
// the flag system is the contract that makes the gap visible instead of silent.
//
// SCRAPE_OFFLINE=1 → every fetch serves $SCRAPE_FIXTURE_HTML from disk ($0 tests).
//
// Deterministic extraction (no LLM): metadata, headings, images, product pages,
// social handles, tech hints (shopify), text for the LLM passes. Ported from
// v1 lib/scrape-website.js (proven in prod) and extended.

import fs from 'fs';

const TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 1024 * 1024;

export function browserHeaders(extra = {}) {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
    ...extra,
  };
}

// ── tiny HTML helpers (regex-based — metadata, not DOM walking) ──────────────
export function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/g, ' ');
}
export function stripTags(s) {
  return decodeEntities(String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ').trim());
}
function findAll(re, html) {
  const out = []; let m;
  while ((m = re.exec(html)) !== null) out.push(m);
  return out;
}
function metaContent(html, attrName, attrValue) {
  const re = new RegExp(`<meta\\s+[^>]*\\b${attrName}\\s*=\\s*["']${attrValue}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, 'i');
  const m1 = html.match(re);
  if (m1) return decodeEntities(m1[1]);
  const re2 = new RegExp(`<meta\\s+[^>]*?content\\s*=\\s*["']([^"']*)["'][^>]*\\b${attrName}\\s*=\\s*["']${attrValue}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1]) : null;
}
function absoluteUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return null; }
}
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

// ── fetch ladder ──────────────────────────────────────────────────────────────
export async function fetchPage(url, timeoutMs = TIMEOUT_MS) {
  if (process.env.SCRAPE_OFFLINE === '1') {
    const fixture = process.env.SCRAPE_FIXTURE_HTML;
    if (!fixture || !fs.existsSync(fixture)) throw new Error('SCRAPE_OFFLINE=1 but SCRAPE_FIXTURE_HTML missing');
    return { html: fs.readFileSync(fixture, 'utf8'), status: 200, rung: 'fixture' };
  }
  const attempts = [
    { rung: 'browser', headers: browserHeaders() },
    { rung: 'bot', headers: { 'User-Agent': 'PhantomBot/2.0 (+https://online-phantom.com)', 'Accept': 'text/html,application/xhtml+xml,*/*' } },
  ];
  let last = null;
  for (const attempt of attempts) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: attempt.headers, redirect: 'follow' });
      const ctype = r.headers.get('content-type') || '';
      if (!r.ok) { last = { error: `${attempt.rung} HTTP ${r.status}`, status: r.status }; continue; }
      if (!/text\/html|application\/xhtml\+xml/i.test(ctype)) { last = { error: `content-type '${ctype}'`, status: r.status }; continue; }
      let html = await r.text();
      if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);
      return { html, status: r.status, rung: attempt.rung, finalUrl: r.url };
    } catch (err) {
      last = { error: err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message, status: 0 };
    } finally { clearTimeout(t); }
  }
  const e = new Error(last?.error || 'fetch failed');
  e.status = last?.status ?? 0;
  throw e;
}

// Blocked/anti-bot/JS-shell detection → the honest per-source flag.
export function detectBlocked(html, status = 200) {
  if (status === 403 || status === 429) return { blocked: true, reason: `HTTP ${status} (WAF)` };
  const h = String(html || '');
  if (/cf-challenge|challenge-platform|cf_chl_|turnstile|just a moment/i.test(h)) return { blocked: true, reason: 'Cloudflare challenge' };
  if (/captcha|are you a robot|access denied|blocked/i.test(h.slice(0, 4000)) && h.length < 20000) return { blocked: true, reason: 'captcha/denied page' };
  const text = stripTags(h);
  if (text.length < 200 && /<script/i.test(h)) return { blocked: true, reason: 'JS-only shell (needs headless render)' };
  return { blocked: false };
}

// ── page discovery: nav links categorized, sitemap fallback ──────────────────
const PAGE_HINTS = [
  { key: 'about', re: /\/(about|our-story|story|mission|who-we-are)\b/i },
  { key: 'products', re: /\/(products?|shop|store|collections?|catalog|menu|services?|pricing)\b/i },
  { key: 'faq', re: /\/(faq|help|support|contact)\b/i },
];

export function discoverPages(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = uniq(findAll(/<a[^>]+href=["']([^"'#]+)["']/gi, html)
    .map((m) => absoluteUrl(base, m[1]))
    .filter((u) => {
      try { return new URL(u).hostname === base.hostname; } catch { return false; }
    }));
  const picked = { about: [], products: [], faq: [] };
  for (const u of links) {
    for (const { key, re } of PAGE_HINTS) {
      if (re.test(new URL(u).pathname)) { picked[key].push(u); break; }
    }
  }
  return {
    about: picked.about.slice(0, 2),
    products: picked.products.slice(0, 4),
    faq: picked.faq.slice(0, 1),
    all_internal: links.slice(0, 100),
  };
}

// ── deterministic extraction (v1 port, extended) ─────────────────────────────
const SOCIAL_MAP = {
  instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9_.\-]+)/i,
  tiktok: /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@?([A-Za-z0-9_.\-]+)/i,
  youtube: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:@|channel\/|user\/)?([A-Za-z0-9_.\-]+)/i,
  twitter: /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i,
  facebook: /(?:https?:\/\/)?(?:www\.)?facebook\.com\/([A-Za-z0-9_.\-]+)/i,
  linkedin: /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:company|in)\/([A-Za-z0-9_.\-]+)/i,
  spotify: /(?:https?:\/\/)?open\.spotify\.com\/(?:artist|user)\/([A-Za-z0-9]+)/i,
  soundcloud: /(?:https?:\/\/)?(?:www\.)?soundcloud\.com\/([A-Za-z0-9_\-]+)/i,
};
const HANDLE_STOPWORDS = new Set(['p', 'embed', 'about', 'help', 'legal', 'pages', 'sharer', 'share', 'intent', 'hashtag', 'explore', 'reel', 'stories']);

export function extractDeterministic(html, sourceUrl) {
  const base = new URL(sourceUrl);
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const description = metaContent(html, 'name', 'description') || metaContent(html, 'property', 'og:description') || null;
  const ogTitle = metaContent(html, 'property', 'og:title');
  const ogImage = metaContent(html, 'property', 'og:image');
  const ogSiteName = metaContent(html, 'property', 'og:site_name');

  const headings = findAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, html)
    .map((m) => ({ level: parseInt(m[1], 10), text: stripTags(m[2]) }))
    .filter((h) => h.text.length > 0 && h.text.length < 220)
    .slice(0, 30);

  const imgs = uniq(
    findAll(/<img[^>]+?(?:src|data-src)=["']([^"']+)["']/gi, html)
      .map((m) => absoluteUrl(base, m[1]))
      .filter((u) => u && /^https?:\/\//i.test(u)
        && !/\{\{|\}\}|%7b|%7d/i.test(u)
        && !/(^|\/)(spinner|loading|pixel|tracking|sprite|placeholder)/i.test(u)),
  ).slice(0, 30);

  const faviconRel = (html.match(/<link[^>]+rel=["'](?:shortcut\s+icon|icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["']/i) || [])[1];

  const handles = {};
  for (const [platform, re] of Object.entries(SOCIAL_MAP)) {
    const m = html.match(re);
    if (m && m[1] && !HANDLE_STOPWORDS.has(m[1].toLowerCase())) handles[platform] = m[1];
  }

  const tech = {
    shopify: /cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i.test(html),
    music_platforms: ['spotify', 'soundcloud'].filter((p) => handles[p])
      .concat(/music\.apple\.com/i.test(html) ? ['apple_music'] : [])
      .concat(/music\.youtube\.com/i.test(html) ? ['youtube_music'] : []),
  };

  return {
    name: ogSiteName || ogTitle || title.split(/[|–—-]/)[0].trim() || base.hostname,
    title, description,
    og: { title: ogTitle, image: ogImage, site_name: ogSiteName },
    headings,
    images: imgs,
    logo: ogImage || (faviconRel ? absoluteUrl(base, faviconRel) : null),
    handles,
    tech,
    text: stripTags(html).slice(0, 12000),
  };
}

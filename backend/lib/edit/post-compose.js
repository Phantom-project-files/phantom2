// lib/edit/post-compose.js — the post design composite (Phase 5).
//
// BPMN: "posts will be initially nano banana generated image and then a
// recognized pinterest design that works with the key brand guideline."
//
// `compose_post` job (auto-enqueued when the base image lands in Phase 4):
//   1. pick a design ARCHETYPE from brief.design_prompt keywords (v1's proven
//      layout library, condensed: stat-card / quote / product-hero)
//   2. build a fully self-contained 1080×1350 HTML composite: base image +
//      typography + brand color hints from the scrape
//   3. headless system Chrome screenshot (v1's per-render-profile fix, ported)
//   4. PNG → R2 kind='post_final' (ref piece) + archetype in meta
//
// MOCK_MEDIA_GEN=1 → mock bytes + archetype pick recorded (no Chrome needed).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pieces, mediaAssets, events } from '../db.js';
import { storage } from '../storage.js';
import { logEvent } from '../logs.js';
import * as jobs from '../jobs.js';
import { htmlToPng } from './chrome-shot.js';

const MOCK = () => process.env.MOCK_MEDIA_GEN === '1';
const MOCK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// Condensed archetype library (full v1 design system lands with the QC-polish pass).
const ARCHETYPES = {
  stat_card: { match: /stat|number|metric|count|%|percent/i },
  quote: { match: /quote|testimonial|statement|manifesto|post-it/i },
  product_hero: { match: /.*/ }, // default
};
export function pickArchetype(designPrompt) {
  for (const [key, a] of Object.entries(ARCHETYPES)) {
    if (a.match.test(String(designPrompt || ''))) return key;
  }
  return 'product_hero';
}

const escHtml = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function compositeHtml({ archetype, imageUrl, caption, cta, brandName, accent }) {
  const safeCaption = escHtml(caption).slice(0, 140);
  const body = archetype === 'quote'
    ? `<div class="ph"><img src="${imageUrl}"><div class="scrim"></div></div>
       <div class="copy quote"><div class="mark">“</div><h1>${safeCaption}</h1><div class="rule"></div><span class="brand">${escHtml(brandName)}</span></div>`
    : archetype === 'stat_card'
      ? `<div class="ph small"><img src="${imageUrl}"></div>
         <div class="copy stat"><h1>${safeCaption}</h1><span class="cta">${escHtml(cta || '')}</span><span class="brand">${escHtml(brandName)}</span></div>`
      : `<div class="ph full"><img src="${imageUrl}"><div class="scrim"></div></div>
         <div class="copy hero"><h1>${safeCaption}</h1><span class="cta">${escHtml(cta || '')}</span><span class="brand">${escHtml(brandName)}</span></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:1080px; height:1350px; background:#0a0b10; font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; color:#fff; position:relative; overflow:hidden; }
  .ph { position:absolute; inset:0; } .ph img { width:100%; height:100%; object-fit:cover; }
  .ph.small { inset:0 0 42% 0; }
  .scrim { position:absolute; inset:0; background:linear-gradient(180deg, transparent 40%, rgba(10,11,16,.92) 82%); }
  .copy { position:absolute; left:64px; right:64px; bottom:64px; display:flex; flex-direction:column; gap:18px; }
  .copy.stat { top:60%; bottom:auto; }
  h1 { font-size:64px; line-height:1.08; font-weight:800; letter-spacing:-.01em; }
  .quote h1 { font-size:56px; font-weight:700; }
  .stat h1 { font-size:88px; color:${accent}; }
  .mark { font-size:120px; color:${accent}; line-height:.6; font-weight:800; }
  .rule { width:72px; height:3px; background:${accent}; }
  .cta { font-size:26px; color:${accent}; font-weight:600; letter-spacing:.02em; }
  .brand { font-size:22px; letter-spacing:.32em; text-transform:uppercase; color:rgba(255,255,255,.55); font-weight:500; }
  </style></head><body>${body}</body></html>`;
}

export async function runComposePost({ pieceId }) {
  const piece = pieces.byId(pieceId);
  if (!piece) throw new Error(`piece ${pieceId} not found`);
  if (mediaAssets.byRef('piece', piece.id).some((a) => a.kind === 'post_final')) return { already: true };
  const slug = piece.tenant_slug;
  const brief = JSON.parse(piece.brief);
  const archetype = pickArchetype(brief.design_prompt);
  const brandName = slug.replace(/-[a-z0-9]{4}$/, '').replace(/-/g, ' ').toUpperCase();

  if (MOCK()) {
    const key = storage.makeKey(slug, 'post', 'png');
    await storage.put(slug, key, MOCK_PNG, 'image/png');
    mediaAssets.record({
      tenantSlug: slug, kind: 'post_final', r2Key: key, contentType: 'image/png', sizeBytes: MOCK_PNG.length,
      refKind: 'piece', refId: piece.id, meta: { mock: true, archetype, stage: 'composite' },
    });
  } else {
    const base = mediaAssets.byRef('piece', piece.id).find((a) => a.kind === 'post');
    if (!base) throw new Error(`post ${pieceId}: base image not in media_assets yet`);
    const imageUrl = await storage.signedGet(slug, base.r2_key, 600);
    const html = compositeHtml({
      archetype, imageUrl, caption: brief.caption, cta: brief.cta, brandName,
      accent: process.env.POST_ACCENT_COLOR || '#9d86ff',
    });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-post-'));
    try {
      const outPath = path.join(work, 'post.png');
      await htmlToPng(html, outPath, { width: 1080, height: 1350, scale: 2 });
      const buf = fs.readFileSync(outPath);
      const key = storage.makeKey(slug, 'post', 'png');
      await storage.put(slug, key, buf, 'image/png');
      mediaAssets.record({
        tenantSlug: slug, kind: 'post_final', r2Key: key, contentType: 'image/png', sizeBytes: buf.length,
        refKind: 'piece', refId: piece.id, meta: { archetype, stage: 'composite' },
      });
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  events.record({ tenantSlug: slug, name: 'edit.post_composed', props: { pieceId: piece.id, archetype } });
  logEvent({ event: 'edit.post_composed', tenantSlug: slug, refId: piece.id, message: archetype });
  return { ok: true, archetype };
}

export function registerComposeJobs() {
  jobs.register('compose_post', (p) => runComposePost(p), { concurrency: 2 });
}

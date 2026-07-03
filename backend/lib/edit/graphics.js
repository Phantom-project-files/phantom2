// lib/edit/graphics.js — the reel graphics pass (Phase 5).
//
// The BPMN's "Graphics prompt" stage: motion media on top of the assembled reel
// (infographics, motion curves, chalk effects, brand logo end-card).
//
// Backends behind one call:
//   chrome_overlay (DEFAULT, real now) — the end-card is rendered as a transparent
//       PNG by headless Chrome (real typography, brand-stylable) and composited
//       onto the last ~1.4s with ffmpeg's core `overlay` filter. Chosen over
//       drawtext because drawtext is a BUILD-DEPENDENT filter (the operator's brew
//       ffmpeg ships without it — found in real verification); overlay is always there.
//   remotion (REMOTION_ENABLED=1) — full motion-graphics compositions driven by
//       brief.graphics_notes. Scaffolding is on the post-build checklist; until
//       then it flags and falls back to chrome_overlay.
//
// Returns { path, backend, flags } — a graphics failure never throws the reel away.

import path from 'path';
import { spawn } from 'child_process';
import { FFMPEG } from './audio.js';
import { htmlToPng, chromeAvailable } from './chrome-shot.js';

function ff(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

// Duration probe without ffprobe: decode to the null muxer, read the last time= stamp.
function probeDuration(inputPath) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-i', inputPath, '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const stamps = err.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
      if (!stamps) return resolve(null);
      const m = stamps[stamps.length - 1].match(/time=(\d+):(\d+):(\d+\.\d+)/);
      resolve(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]));
    });
  });
}

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function endcardHtml(brand, accent) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; } html, body { background:transparent; }
  body { width:1080px; height:1920px; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; }
  .card { background:rgba(6,7,12,.55); border-radius:26px; padding:44px 72px; text-align:center;
          border:1px solid rgba(255,255,255,.14); backdrop-filter:blur(6px); }
  h1 { color:#fff; font-size:74px; font-weight:800; letter-spacing:.14em; }
  .rule { width:88px; height:4px; background:${accent}; margin:20px auto 0; border-radius:2px; }
  </style></head><body><div class="card"><h1>${esc(brand)}</h1><div class="rule"></div></div></body></html>`;
}

export async function applyGraphics({ inputPath, workDir, piece, brief }) {
  const flags = [];
  if (process.env.REMOTION_ENABLED === '1') {
    flags.push('remotion requested but not scaffolded yet — chrome_overlay fallback (post-build checklist)');
  }
  const brand = piece.tenant_slug.replace(/-[a-z0-9]{4}$/, '').replace(/-/g, ' ').toUpperCase() || 'PHANTOM';
  const out = path.join(workDir, 'final.mp4');
  try {
    if (!chromeAvailable()) throw new Error('no Chrome for end-card render');
    const cardPath = path.join(workDir, 'endcard.png');
    await htmlToPng(endcardHtml(brand, process.env.POST_ACCENT_COLOR || '#9d86ff'), cardPath,
      { width: 1080, height: 1920, scale: 1, transparent: true });
    const dur = await probeDuration(inputPath);
    const start = Math.max(0, (dur || 6) - 1.4);
    await ff(['-i', inputPath, '-i', cardPath, '-filter_complex',
      `[1:v]format=rgba[card];[0:v][card]overlay=0:0:enable='gte(t,${start.toFixed(2)})'`,
      '-c:a', 'copy', out]);
    return { path: out, backend: 'chrome_overlay', flags };
  } catch (err) {
    // never lose the reel over an overlay — ship it un-graphed, flagged
    flags.push(`graphics pass failed (${err.message.slice(0, 120)}) — reel shipped without end-card`);
    return { path: inputPath, backend: 'none', flags };
  }
}

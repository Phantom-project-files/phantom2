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
//   remotion (REMOTION_ENABLED=1) — motion-graphics compositions from the repo-root
//       remotion/ project, driven by brief.graphics_notes: an animated EndCard
//       always, plus one accent overlay (infographic / motion curves / chalk) when
//       the notes ask for it. Rendered as alpha ProRes by lib/edit/remotion.js and
//       ffmpeg-composited here. ANY remotion error falls back to chrome_overlay —
//       graphics polish must never sink the reel.
//
// Returns { path, backend, flags } — a graphics failure never throws the reel away.

import path from 'path';
import { spawn } from 'child_process';
import { FFMPEG } from './audio.js';
import { htmlToPng, chromeAvailable } from './chrome-shot.js';
import { remotionEnabled, accentForNotes, renderOverlay } from './remotion.js';
import { logEvent } from '../logs.js';

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

// Remotion pass: animated EndCard over the same last-1.4s window as the chrome
// card, plus one accent overlay (per graphics_notes) in the reel body. Overlays
// arrive as alpha ProRes .movs; setpts shifts them to their start time, enable
// gates compositing to the window, eof_action=pass hands frames back after.
async function remotionPass({ inputPath, out, workDir, brand, accent, brief }) {
  const dur = (await probeDuration(inputPath)) || 6;
  const endStart = Math.max(0, dur - 1.4);
  const endMov = path.join(workDir, 'endcard.mov');
  await renderOverlay({ id: 'EndCard', inputProps: { logoText: brand, accent }, outPath: endMov });

  const accentId = accentForNotes(brief?.graphics_notes);
  const args = ['-i', inputPath, '-i', endMov];
  const endChain = (label) => `${label}[end]overlay=0:0:eof_action=pass:enable='gte(t,${endStart.toFixed(2)})'`;
  let filter = `[1:v]setpts=PTS-STARTPTS+${endStart.toFixed(2)}/TB,format=rgba[end];`;
  if (accentId && dur > 4) { // short reels get the end-card only — no room for a beat
    const accMov = path.join(workDir, 'accent.mov');
    const inputProps = accentId === 'InfographicOverlay'
      ? { headline: brief?.hook || brief?.caption || '', accent }
      : { accent };
    await renderOverlay({ id: accentId, inputProps, outPath: accMov });
    args.push('-i', accMov);
    const aStart = 0.6;
    const aEnd = Math.min(aStart + 2.4, endStart);
    filter += `[2:v]setpts=PTS-STARTPTS+${aStart.toFixed(2)}/TB,format=rgba[acc];`
      + `[0:v][acc]overlay=0:0:eof_action=pass:enable='between(t,${aStart.toFixed(2)},${aEnd.toFixed(2)})'[v1];`
      + endChain('[v1]');
  } else {
    filter += endChain('[0:v]');
  }
  await ff([...args, '-filter_complex', filter, '-c:a', 'copy', out], 240000);
  return accentId && dur > 4 ? ['EndCard', accentId] : ['EndCard'];
}

export async function applyGraphics({ inputPath, workDir, piece, brief }) {
  const flags = [];
  const brand = piece.tenant_slug.replace(/-[a-z0-9]{4}$/, '').replace(/-/g, ' ').toUpperCase() || 'PHANTOM';
  const accent = process.env.POST_ACCENT_COLOR || '#9d86ff';
  const out = path.join(workDir, 'final.mp4');
  if (remotionEnabled()) {
    try {
      const comps = await remotionPass({ inputPath, out, workDir, brand, accent, brief });
      return { path: out, backend: 'remotion', flags: [...flags, `remotion comps: ${comps.join('+')}`] };
    } catch (err) {
      // polish, not payload — log and drop to the always-there chrome_overlay path
      flags.push(`remotion graphics failed (${err.message.slice(0, 120)}) — chrome_overlay fallback`);
      logEvent({ level: 'warn', event: 'remotion.fallback', tenantSlug: piece.tenant_slug, refId: piece.id, message: err.message.slice(0, 300) });
    }
  }
  try {
    if (!chromeAvailable()) throw new Error('no Chrome for end-card render');
    const cardPath = path.join(workDir, 'endcard.png');
    await htmlToPng(endcardHtml(brand, accent), cardPath,
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

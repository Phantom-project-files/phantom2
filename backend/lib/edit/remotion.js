// lib/edit/remotion.js — thin boundary to the Remotion project (post-build item 7).
//
// The remotion/ project at REPO ROOT owns every Remotion dep (react, webpack,
// @remotion/*) — nothing enters backend/package.json, and the Fly image never
// ships it (Docker context is backend/). This module reaches into
// remotion/node_modules via createRequire ON FIRST RENDER only, so with
// REMOTION_ENABLED unset — or the project absent/uninstalled — it is fully
// inert: importing it resolves nothing and changes no behavior.
//
// Renders are programmatic (@remotion/renderer): one webpack bundle per process
// (cached promise — the slow part), then selectComposition + renderMedia/renderStill
// per call. Reel overlays render as ProRes 4444 + yuva444p10le so ffmpeg can
// alpha-composite MOVING graphics onto the reel (mp4 carries no alpha channel).
// First render on a fresh machine also downloads Chrome Headless Shell (~once).
//
// NOTE: the caption layer was removed from this product on purpose — this module
// renders graphics compositions only, never captions/subtitles.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { logEvent } from '../logs.js';

const PROJECT_DIR = () => process.env.REMOTION_PROJECT_DIR
  || path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'remotion');
const entry = () => path.join(PROJECT_DIR(), 'src', 'index.ts');

const TIMEOUT = () => parseInt(process.env.REMOTION_TIMEOUT_MS || '180000', 10);
const CONCURRENCY = () => parseInt(process.env.REMOTION_CONCURRENCY || '2', 10);

// enabled = opted in AND the project is actually installed (a set flag on a box
// without the project — e.g. Fly — must not error, just skip to chrome_overlay)
export function remotionEnabled() {
  return process.env.REMOTION_ENABLED === '1'
    && fs.existsSync(entry())
    && fs.existsSync(path.join(PROJECT_DIR(), 'node_modules', '@remotion', 'renderer'));
}

// brief.graphics_notes → accent composition id (EndCard is unconditional and
// handled by the caller; this picks the optional mid-reel accent)
export function accentForNotes(notes) {
  const s = String(notes || '');
  if (/infograph|stat|number|metric|%|percent/i.test(s)) return 'InfographicOverlay';
  if (/chalk|scribble|hand.?drawn|sketch/i.test(s)) return 'ChalkEffect';
  if (/curve|swoosh|motion|accent/i.test(s)) return 'MotionCurveAccents';
  return null;
}

let _mods = null;   // @remotion/* resolved from remotion/node_modules, once
let _bundle = null; // webpack bundle promise, once per process

function mods() {
  if (!_mods) {
    const req = createRequire(path.join(PROJECT_DIR(), 'package.json'));
    _mods = { bundler: req('@remotion/bundler'), renderer: req('@remotion/renderer') };
  }
  return _mods;
}

function serveUrl() {
  if (!_bundle) {
    _bundle = mods().bundler.bundle({ entryPoint: entry() });
    _bundle.catch(() => { _bundle = null; }); // a failed bundle must not poison later renders
  }
  return _bundle;
}

async function composition(id, inputProps) {
  return await mods().renderer.selectComposition({
    serveUrl: await serveUrl(), id, inputProps, timeoutInMilliseconds: TIMEOUT(),
  });
}

// Alpha overlay (.mov, ProRes 4444) — for ffmpeg compositing onto a reel.
// muted: overlays must carry NO audio track, or ffmpeg's default stream
// selection could pick the overlay's silence over the reel's music.
export async function renderOverlay({ id, inputProps, outPath }) {
  const t0 = Date.now();
  await mods().renderer.renderMedia({
    serveUrl: await serveUrl(), composition: await composition(id, inputProps),
    codec: 'prores', proResProfile: '4444', imageFormat: 'png', pixelFormat: 'yuva444p10le',
    muted: true, inputProps, outputLocation: outPath,
    concurrency: CONCURRENCY(), timeoutInMilliseconds: TIMEOUT(),
  });
  logEvent({ event: 'remotion.render', refId: id, message: `overlay ${id} in ${Date.now() - t0}ms` });
  return outPath;
}

// Opaque mp4 (h264) — full-frame compositions rendered standalone.
export async function renderVideo({ id, inputProps, outPath }) {
  const t0 = Date.now();
  await mods().renderer.renderMedia({
    serveUrl: await serveUrl(), composition: await composition(id, inputProps),
    codec: 'h264', inputProps, outputLocation: outPath,
    concurrency: CONCURRENCY(), timeoutInMilliseconds: TIMEOUT(),
  });
  logEvent({ event: 'remotion.render', refId: id, message: `video ${id} in ${Date.now() - t0}ms` });
  return outPath;
}

// Single frame png — post stills (4:5 PostStill and friends).
export async function renderStillPng({ id, inputProps, outPath }) {
  const t0 = Date.now();
  await mods().renderer.renderStill({
    serveUrl: await serveUrl(), composition: await composition(id, inputProps),
    inputProps, output: outPath, imageFormat: 'png', timeoutInMilliseconds: TIMEOUT(),
  });
  logEvent({ event: 'remotion.render', refId: id, message: `still ${id} in ${Date.now() - t0}ms` });
  return outPath;
}

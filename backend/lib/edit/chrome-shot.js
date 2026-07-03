// lib/edit/chrome-shot.js — shared headless-Chrome HTML→PNG helper (Phase 5).
// v1-proven pattern: system Chrome, per-render --user-data-dir (concurrent renders
// collide on a shared profile lock), virtual-time budget for settled paint.
// Used by post-compose (composites) and graphics (end-card overlays).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

let _browser;
export function browserPath() {
  if (_browser) return _browser;
  _browser = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!_browser) throw new Error('No Chrome/Chromium found — set CHROME_PATH');
  return _browser;
}

export function chromeAvailable() {
  try { return !!browserPath(); } catch { return false; }
}

// Render an HTML string to a PNG file. transparent:true keeps alpha (overlays).
export async function htmlToPng(html, outPath, { width = 1080, height = 1350, scale = 2, transparent = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-shot-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-chrome-'));
  try {
    const htmlPath = path.join(work, 'page.html');
    fs.writeFileSync(htmlPath, html);
    await execFileP(browserPath(), [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`,
      ...(transparent ? ['--default-background-color=00000000'] : []),
      '--virtual-time-budget=4000', '--run-all-compositor-stages-before-draw',
      `--user-data-dir=${profileDir}`, `--screenshot=${outPath}`, `file://${htmlPath}`,
    ], { timeout: 45000 });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 500) {
      throw new Error('headless render produced no/empty PNG');
    }
    return outPath;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

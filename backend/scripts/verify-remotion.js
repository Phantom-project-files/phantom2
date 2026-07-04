// scripts/verify-remotion.js — proves the Remotion scaffold renders for REAL.
// $0, no APIs, no media assets needed: bundles the remotion/ project, renders the
// EndCard overlay (alpha ProRes .mov) + the PostStill (png) with sample brand
// tokens to a scratch dir, and checks the outputs exist and are non-trivial.
// First run on a machine is slow: webpack bundle + Chrome Headless Shell download.
// `node scripts/verify-remotion.js`

import fs from 'fs';
import os from 'os';
import path from 'path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom2-remotion-'));
process.env.PHANTOM_DB_PATH = path.join(scratch, 'verify.db'); // logEvent → scratch DB, not the real one
process.env.REMOTION_ENABLED = '1';

const { remotionEnabled, accentForNotes, renderOverlay, renderStillPng } = await import('../lib/edit/remotion.js');

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`); if (!cond) failures++; };

check('remotion project installed + flag honored', remotionEnabled());
if (!remotionEnabled()) {
  console.log('remotion/ not installed — run `npm install` in <repo>/remotion first');
  process.exit(1);
}

// graphics_notes → composition routing (what graphics.js keys off)
check('graphics_notes routing (stat/chalk/curves/none)',
  accentForNotes('brand logo end-card, one animated stat overlay') === 'InfographicOverlay'
  && accentForNotes('chalk scribble on the hook') === 'ChalkEffect'
  && accentForNotes('motion curve swoosh') === 'MotionCurveAccents'
  && accentForNotes('just the logo') === null);

// real renders — sample brand tokens only, no hardcoded brand anywhere
const mov = path.join(scratch, 'endcard.mov');
let t0 = Date.now();
await renderOverlay({ id: 'EndCard', inputProps: { logoText: 'SAMPLE BRAND', accent: '#9d86ff' }, outPath: mov });
check(`EndCard alpha overlay rendered (${((Date.now() - t0) / 1000).toFixed(1)}s, ${fs.statSync(mov).size} bytes)`,
  fs.existsSync(mov) && fs.statSync(mov).size > 10000);

const png = path.join(scratch, 'post.png');
t0 = Date.now();
await renderStillPng({ id: 'PostStill', inputProps: { logoText: 'SAMPLE BRAND', headline: 'Sold out in 9 minutes', accent: '#9d86ff', bg: '#0a0b10' }, outPath: png });
check(`PostStill 1080x1350 png rendered (${((Date.now() - t0) / 1000).toFixed(1)}s, ${fs.statSync(png).size} bytes)`,
  fs.existsSync(png) && fs.statSync(png).size > 5000);

console.log(failures ? `\n${failures} FAILURES — outputs kept at ${scratch}` : `\nremotion scaffold verified — outputs at ${scratch}`);
process.exit(failures ? 1 : 0);

// scripts/verify-edit-real.js — REAL-path verification of the Phase 5 edit layer.
// Needs ffmpeg (+ Chrome for the post composite). Uses a scratch DB and ffmpeg-
// synthesized media (color-pattern shots + a burst track) — still $0, no APIs —
// but exercises the actual filter graphs, concat, audio lay, end-card, and the
// headless-Chrome composite. `node scripts/verify-edit-real.js`

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom2-real-edit-'));
process.env.PHANTOM_DB_PATH = path.join(scratch, 'real.db');
process.env.PHANTOM_MEDIA_ROOT = path.join(scratch, 'media');   // keep storage.put()s out of the real data/media tree
process.env.CLAUDE_MODE = 'mock';
process.env.MOCK_MEDIA_GEN = '0';          // REAL edit paths
process.env.STORAGE_BACKEND = 'local';

const { db, tenants, intakes, campaigns, pieces, phantoms, mediaAssets, audioTracks } = await import('../lib/db.js');
const { storage } = await import('../lib/storage.js');
const { runAssembleReel } = await import('../lib/edit/assemble.js');
const { runComposePost } = await import('../lib/edit/post-compose.js');
const { FFMPEG, ffmpegAvailable } = await import('../lib/edit/audio.js');

if (!(await ffmpegAvailable())) { console.log('ffmpeg missing — cannot run real verification'); process.exit(1); }

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`); if (!cond) failures++; };
const ff = (args) => new Promise((res, rej) => {
  const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  let e = ''; p.stderr.on('data', (d) => e += d);
  p.on('close', (c) => c === 0 ? res() : rej(new Error(e.slice(0, 300)))); p.on('error', rej);
});

// seed: tenant / intake / campaign / phantom / one reel + one post piece
const tenant = tenants.create({ businessName: 'Real Edit Co', website: 'https://real.example', suffix: 'r34l' });
const intake = intakes.create({ id: 'real-edit-1', tenantSlug: tenant.slug, businessName: 'Real Edit Co', website: 'https://real.example' });
const camp = campaigns.create({ tenantSlug: tenant.slug, intakeId: intake.id, title: 'Real', type: 'product', concept: 'x', visualDesign: 'warm' });
const ph = phantoms.cast({ tenantSlug: tenant.slug, intakeId: intake.id, name: 'Maya', appearancePrompt: 'synthetic creator' });
pieces.createMany([
  { tenantSlug: tenant.slug, intakeId: intake.id, campaignId: camp.id, phantomId: ph.id, kind: 'reel', scheduledDate: '2026-07-04',
    brief: { kind: 'reel', hook: 'x', frame_prompts: ['a', 'b'], video_description: 'v', audio_vibe: 'upbeat summer', graphics_notes: 'logo end', caption: 'Real caption', cta: 'Shop' } },
  { tenantSlug: tenant.slug, intakeId: intake.id, campaignId: camp.id, phantomId: ph.id, kind: 'post', scheduledDate: '2026-07-04', pillar: 'product',
    brief: { kind: 'post', post_prompt: 'x', design_prompt: 'oversized number stat', caption: 'Sold out in 9 minutes', cta: 'Get yours' } },
]);
const [reelPiece, postPiece] = pieces.byIntake(intake.id);

// synth media: two 6s color-pattern shots, a 14s burst track, a 1080x1350 post base image
const mk = (name) => path.join(scratch, name);
await ff(['-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=6', '-pix_fmt', 'yuv420p', mk('shot0.mp4')]);
await ff(['-f', 'lavfi', '-i', 'smptebars=size=540x960:rate=30:duration=6', '-pix_fmt', 'yuv420p', mk('shot1.mp4')]);
await ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=14',
  '-af', "volume='if(between(t,4,4.5)+between(t,8,8.5),1.0,0.06)':eval=frame", '-b:a', '128k', mk('track.mp3')]);
await ff(['-f', 'lavfi', '-i', 'gradients=size=1080x1350:duration=0.1', '-frames:v', '1', mk('base.png')]);

// place them where the pipeline expects (R2/local keys + rows)
async function put(slug, kind, ext, file, ctype, refKind, refId, meta) {
  const key = storage.makeKey(slug, kind, ext);
  await storage.put(slug, key, fs.readFileSync(file), ctype);
  mediaAssets.record({ tenantSlug: slug, kind, r2Key: key, contentType: ctype, refKind, refId, meta });
  return key;
}
await put(tenant.slug, 'shot', 'mp4', mk('shot0.mp4'), 'video/mp4', 'campaign', camp.id, { campaign_id: camp.id, slot: 0, source_piece_id: reelPiece.id });
await put(tenant.slug, 'shot', 'mp4', mk('shot1.mp4'), 'video/mp4', 'campaign', camp.id, { campaign_id: camp.id, slot: 1, source_piece_id: 999999 }); // sibling shot → reuse path
await put(tenant.slug, 'post', 'png', mk('base.png'), 'image/png', 'piece', postPiece.id, { piece_id: postPiece.id, stage: 'base_image' });
const trackKey = storage.makeKey('library', 'audio', 'mp3');
await storage.put('library', trackKey, fs.readFileSync(mk('track.mp3')), 'audio/mpeg');
audioTracks.add({ title: 'Burst', licenseNote: 'synthetic', r2Key: trackKey, vibeTags: ['upbeat', 'summer'] });

// REAL assembly
const asm = await runAssembleReel({ pieceId: reelPiece.id });
const reelAsset = mediaAssets.byRef('piece', reelPiece.id).find((a) => a.kind === 'reel');
const meta = JSON.parse(reelAsset?.meta || '{}');
check('real assembly produced a reel asset', asm.ok === true && !!reelAsset);
check(`reel is real video (${reelAsset?.size_bytes} bytes, >100KB)`, (reelAsset?.size_bytes || 0) > 100_000);
check('used both shots incl. the reused sibling', meta.shots?.length === 2 && meta.shots.some((s) => s.reused));
check(`cut plan computed from real onsets (onsets_used=${meta.onsets_used})`, meta.onsets_used >= 1 && Array.isArray(meta.edit_plan));
check(`graphics end-card applied (backend=${meta.graphics})`, meta.graphics === 'chrome_overlay');

// REAL post composite (needs Chrome)
try {
  const comp = await runComposePost({ pieceId: postPiece.id });
  const postAsset = mediaAssets.byRef('piece', postPiece.id).find((a) => a.kind === 'post_final');
  check(`real Chrome composite produced final post (${postAsset?.size_bytes} bytes)`, comp.ok && (postAsset?.size_bytes || 0) > 10_000);
  check('archetype routed from design_prompt', JSON.parse(postAsset.meta).archetype === 'stat_card');
} catch (e) {
  if (/No Chrome/i.test(e.message)) console.log('  ~ skipped: post composite (no Chrome found)');
  else { check(`post composite threw: ${e.message.slice(0, 120)}`, false); }
}

console.log(failures === 0 ? '\n[real-edit] ALL PASS ✅' : `\n[real-edit] ${failures} FAILURE(S) ❌`);
console.log('scratch:', scratch);
process.exit(failures === 0 ? 0 : 1);

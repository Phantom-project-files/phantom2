// lib/edit/assemble.js — the beat-cut reel assembler (Phase 5).
//
// `assemble_reel` job (auto-enqueued when a reel's shots finish in Phase 4):
//   1. gather the reel's shots — its own fresh shots + campaign-pool siblings for
//      reused slots (the cross-reel reuse payoff), ≤3 total (spec cap)
//   2. pick a trending track from the library by brief.audio_vibe (no track →
//      silent, no preview — honest, not blocking)
//   3. detectCuts on the track → buildCutPlan (transitions snap to drops)
//   4. ffmpeg: trim each shot to its segment → concat → graphics end-card
//   5. TWO outputs (the trending-audio delivery model, 2026-07-04):
//        · kind='reel'         — the SILENT master, the download deliverable
//        · kind='reel_preview' — silent master + the trending track, GALLERY ONLY
//      The customer previews with sound but downloads silent + an upload-instruction
//      file (built from meta.audio_instruction) and attaches the sound natively —
//      trending/commercial audio can't be legally baked into distributed content.
//
// MOCK_MEDIA_GEN=1 → skips ffmpeg (Phase-4 mock shots aren't real video) but
// runs track-pick + cut-plan math and writes both mock assets — full $0 chain.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { pieces, phantoms, mediaAssets, events, intakes } from '../db.js';
import { storage } from '../storage.js';
import { logEvent } from '../logs.js';
import * as jobs from '../jobs.js';
import { FFMPEG, pickTrack, detectCuts, buildCutPlan } from './audio.js';
import { applyGraphics } from './graphics.js';

const MOCK = () => process.env.MOCK_MEDIA_GEN === '1';
const MOCK_MP4 = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=', 'base64');

function ff(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 400)}`));
    });
  });
}

async function fetchToFile(slug, r2Key, destPath) {
  if (storage.backend === 'local') {
    const src = path.join(storage.localRoot, r2Key);
    fs.copyFileSync(src, destPath);
    return;
  }
  const url = await storage.signedGet(slug, r2Key, 600);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch shot ${r2Key}: HTTP ${r.status}`);
  fs.writeFileSync(destPath, Buffer.from(await r.arrayBuffer()));
}

// The upload-instruction data stored on the silent reel asset: which sound to add,
// where to find it, and the in-video scene-change timestamps (so the customer can
// confirm the beat sync). Built from the picked track + the cut plan.
function audioInstructionFor(picked, cutPlan) {
  if (!picked) return null;
  const t = picked.track;
  let acc = 0;
  const cuts = [];
  for (let i = 0; i < cutPlan.length - 1; i++) {
    acc += Math.max(0.6, cutPlan[i].end - cutPlan[i].start);
    cuts.push(Math.round(acc * 10) / 10);
  }
  return { track_title: t.title, track_artist: t.artist || null, source_url: t.source_url || null, start_sec: 0, cut_times: cuts };
}

// Reel's shot list: fresh (its own) first by slot, then campaign siblings to fill
// up to the brief's frame count (≤3). Dedup by slot.
function shotsForPiece(piece, frameCount) {
  const all = mediaAssets.byRef('campaign', piece.campaign_id).filter((a) => a.kind === 'shot');
  const parse = (a) => ({ a, m: JSON.parse(a.meta || '{}') });
  const own = all.map(parse).filter(({ m }) => m.source_piece_id === piece.id);
  const pool = all.map(parse).filter(({ m }) => m.source_piece_id !== piece.id);
  const bySlot = new Map();
  for (const { a, m } of own) if (!bySlot.has(m.slot)) bySlot.set(m.slot, { a, reused: false });
  for (const { a, m } of pool) if (!bySlot.has(m.slot) && bySlot.size < frameCount) bySlot.set(m.slot, { a, reused: true });
  return [...bySlot.entries()].sort((x, y) => x[0] - y[0]).map(([slot, v]) => ({ slot, ...v })).slice(0, 3);
}

export async function runAssembleReel({ pieceId }) {
  const piece = pieces.byId(pieceId);
  if (!piece) throw new Error(`piece ${pieceId} not found`);
  if (mediaAssets.byRef('piece', piece.id).some((a) => a.kind === 'reel')) return { already: true };
  const slug = piece.tenant_slug;
  const brief = JSON.parse(piece.brief);
  const frameCount = Math.min((brief.frame_prompts || ['x']).length, 3);
  const shots = shotsForPiece(piece, frameCount);
  if (!shots.length) throw new Error(`reel ${pieceId}: no shots in library yet`);

  const flags = [];
  const picked = pickTrack(brief.audio_vibe);
  if (!picked) flags.push('no_track: library empty — silent master, no preview/instruction');

  const shotSec = parseInt(process.env.FAL_VIDEO_DURATION || '6', 10);
  const targetSec = shots.length * shotSec;
  let cutPlan;
  let onsetsUsed = 0;

  if (MOCK()) {
    // exercise the cut math with synthetic onsets; skip ffmpeg on stub bytes
    const onsets = picked ? [2.1, 5.9, 8.2, 11.8, 14.1] : [];
    onsetsUsed = onsets.length;
    cutPlan = buildCutPlan({ shotCount: shots.length, targetSec, onsets, maxSegSec: shotSec });
    const audioInstruction = audioInstructionFor(picked, cutPlan);
    const commonMeta = { mock: true, edit_plan: cutPlan, track_id: picked?.track?.id || null, track_score: picked?.score ?? null, shots: shots.map((s) => ({ slot: s.slot, reused: s.reused })), flags, graphics: 'mock' };
    // silent master (the deliverable)
    const reelKey = storage.makeKey(slug, 'reel', 'mp4');
    await storage.put(slug, reelKey, MOCK_MP4, 'video/mp4');
    mediaAssets.record({
      tenantSlug: slug, kind: 'reel', r2Key: reelKey, contentType: 'video/mp4', sizeBytes: MOCK_MP4.length,
      refKind: 'piece', refId: piece.id,
      meta: { ...commonMeta, audio_mode: picked ? 'silent_delivery' : 'silent_no_track', audio_instruction: audioInstruction },
    });
    // preview WITH the trending track (gallery only) — only when a track exists
    if (picked) {
      const previewKey = storage.makeKey(slug, 'reel', 'mp4');
      await storage.put(slug, previewKey, MOCK_MP4, 'video/mp4');
      mediaAssets.record({
        tenantSlug: slug, kind: 'reel_preview', r2Key: previewKey, contentType: 'video/mp4', sizeBytes: MOCK_MP4.length,
        refKind: 'piece', refId: piece.id,
        meta: { ...commonMeta, preview: true, track_id: picked.track.id },
      });
    }
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-edit-'));
    try {
      const shotFiles = [];
      for (const s of shots) {
        const fp = path.join(work, `shot${s.slot}.mp4`);
        await fetchToFile(slug, s.a.r2_key, fp);
        shotFiles.push(fp);
      }
      let trackFile = null;
      if (picked) {
        trackFile = path.join(work, 'track.mp3');
        await fetchToFile('library', picked.track.r2_key, trackFile);
        const det = await detectCuts(trackFile);
        onsetsUsed = det.onsets.length;
        cutPlan = buildCutPlan({ shotCount: shots.length, targetSec: Math.min(targetSec, det.durationSec), onsets: det.onsets, maxSegSec: shotSec });
      } else {
        cutPlan = buildCutPlan({ shotCount: shots.length, targetSec, onsets: [], maxSegSec: shotSec });
      }
      // trim each shot to its segment length, normalize to 1080x1920
      const segs = [];
      for (let i = 0; i < cutPlan.length; i++) {
        const seg = path.join(work, `seg${i}.mp4`);
        const len = Math.max(0.6, cutPlan[i].end - cutPlan[i].start);
        await ff(['-i', shotFiles[i % shotFiles.length], '-t', len.toFixed(2),
          '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30',
          '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', seg]);
        segs.push(seg);
      }
      const concatList = path.join(work, 'list.txt');
      fs.writeFileSync(concatList, segs.map((s) => `file '${s}'`).join('\n'));
      const joined = path.join(work, 'joined.mp4');
      await ff(['-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', joined]);

      // Graphics end-card on the SILENT cut → the download deliverable (no audio).
      const final = await applyGraphics({ inputPath: joined, workDir: work, piece, brief });
      const silentBuf = fs.readFileSync(final.path);
      const reelKey = storage.makeKey(slug, 'reel', 'mp4');
      await storage.put(slug, reelKey, silentBuf, 'video/mp4');
      const audioInstruction = audioInstructionFor(picked, cutPlan);
      mediaAssets.record({
        tenantSlug: slug, kind: 'reel', r2Key: reelKey, contentType: 'video/mp4', sizeBytes: silentBuf.length,
        refKind: 'piece', refId: piece.id,
        meta: { edit_plan: cutPlan, track_id: picked?.track?.id || null, track_score: picked?.score ?? null, onsets_used: onsetsUsed, shots: shots.map((s) => ({ slot: s.slot, reused: s.reused })), flags: [...flags, ...final.flags], graphics: final.backend, audio_mode: picked ? 'silent_delivery' : 'silent_no_track', audio_instruction: audioInstruction },
      });

      // Preview WITH the trending track (gallery only, excluded from the ZIP) —
      // mux the track under the graphics'd silent master.
      if (trackFile) {
        const previewPath = path.join(work, 'preview.mp4');
        await ff(['-i', final.path, '-i', trackFile, '-map', '0:v', '-map', '1:a',
          '-shortest', '-af', 'afade=t=out:st=' + Math.max(0, cutPlan.at(-1).end - 1).toFixed(2) + ':d=1',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', previewPath]);
        const previewBuf = fs.readFileSync(previewPath);
        const previewKey = storage.makeKey(slug, 'reel', 'mp4');
        await storage.put(slug, previewKey, previewBuf, 'video/mp4');
        mediaAssets.record({
          tenantSlug: slug, kind: 'reel_preview', r2Key: previewKey, contentType: 'video/mp4', sizeBytes: previewBuf.length,
          refKind: 'piece', refId: piece.id,
          meta: { preview: true, track_id: picked.track.id, edit_plan: cutPlan },
        });
      }
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  events.record({ tenantSlug: slug, name: 'edit.reel_assembled', props: { pieceId: piece.id, shots: shots.length, reused: shots.filter((s) => s.reused).length, onsets: onsetsUsed, flags } });
  logEvent({ event: 'edit.reel_assembled', tenantSlug: slug, refId: piece.id, message: `${shots.length} shots (${shots.filter((s) => s.reused).length} reused), track=${picked?.track?.title || 'none'}` });
  return { ok: true, shots: shots.length, flags };
}

export function registerEditJobs() {
  jobs.register('assemble_reel', (p) => runAssembleReel(p), { concurrency: 2 });
}

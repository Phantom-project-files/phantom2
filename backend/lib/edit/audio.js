// lib/edit/audio.js — audio-based editing brains (Phase 5).
//
// Two jobs:
//   1. pickTrack(audioVibe)   — match a brief's audio_vibe against the operator's
//      rights-cleared library (audio_tracks.vibe_tags). AUDIO-SOURCE-AGNOSTIC by
//      design (operator decision 2026-07-02: no ripping; library only).
//   2. detectCuts(trackPath)  — find beat-drop/onset timestamps with ffmpeg + an
//      energy-flux pass, so the assembler can snap shot transitions to the music.
//
// Onset detection (no Python, no deps): ffmpeg decodes the track to raw mono
// 16-bit PCM on stdout → windowed RMS (50ms hop) → flux = max(0, rms[i]-rms[i-1])
// → peaks above mean+K·std with a minimum gap. Bass drops on real tracks are
// exactly these flux spikes; a synthetic tone burst verifies the math in smoke.

import { spawn } from 'child_process';
import { audioTracks } from '../db.js';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export function ffmpegAvailable() {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

// Cheap token-overlap scoring: "upbeat summer pop" vs tags ["upbeat","pop"] → 2.
export function scoreTrack(audioVibe, track) {
  const want = new Set(String(audioVibe || '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  const tags = (() => { try { return JSON.parse(track.vibe_tags || '[]'); } catch { return []; } })();
  let s = 0;
  for (const t of tags) {
    for (const part of String(t).toLowerCase().split(/[^a-z]+/)) if (want.has(part)) s++;
  }
  return s;
}

export function pickTrack(audioVibe) {
  const all = audioTracks.list();
  if (!all.length) return null;
  const scored = all.map((t) => ({ t, s: scoreTrack(audioVibe, t) })).sort((a, b) => b.s - a.s || a.t.id - b.t.id);
  return { track: scored[0].t, score: scored[0].s };
}

// Decode to mono 16-bit 22.05 kHz PCM and return Float32Array samples.
function decodePcm(inputPath, { sampleRate = 22050, maxSeconds = 180 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', inputPath,
      '-t', String(maxSeconds), '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', 'pipe:1'];
    const p = spawn(FFMPEG, args);
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg decode failed: ${err.slice(0, 300)}`));
      const buf = Buffer.concat(chunks);
      const out = new Float32Array(buf.length >> 1);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
      resolve({ samples: out, sampleRate });
    });
  });
}

// Energy-flux onset detection → sorted timestamps (seconds).
export async function detectCuts(inputPath, { minGapSec = 0.8, sensitivity = 1.5 } = {}) {
  const { samples, sampleRate } = await decodePcm(inputPath);
  const hop = Math.floor(sampleRate * 0.05);            // 50 ms windows
  const nWin = Math.floor(samples.length / hop);
  const rms = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    let acc = 0;
    const off = w * hop;
    for (let i = 0; i < hop; i++) { const v = samples[off + i]; acc += v * v; }
    rms[w] = Math.sqrt(acc / hop);
  }
  const flux = new Float32Array(nWin);
  for (let w = 1; w < nWin; w++) flux[w] = Math.max(0, rms[w] - rms[w - 1]);
  const mean = flux.reduce((a, b) => a + b, 0) / nWin;
  const std = Math.sqrt(flux.reduce((a, b) => a + (b - mean) ** 2, 0) / nWin);
  const threshold = mean + sensitivity * std;
  const minGapWin = Math.ceil(minGapSec / 0.05);
  const onsets = [];
  let last = -minGapWin;
  for (let w = 1; w < nWin; w++) {
    if (flux[w] >= threshold && w - last >= minGapWin) { onsets.push(w * 0.05); last = w; }
  }
  return { onsets, durationSec: nWin * 0.05 };
}

// Build the cut plan: split the reel across ≤3 shots with transitions snapped to
// onsets. Falls back to even splits when the track is sparse on drops.
export function buildCutPlan({ shotCount, targetSec, onsets = [] }) {
  const n = Math.max(1, Math.min(shotCount, 3));
  const even = Array.from({ length: n - 1 }, (_, i) => (targetSec * (i + 1)) / n);
  const cuts = even.map((ideal) => {
    const near = onsets
      .filter((o) => o > 0.5 && o < targetSec - 0.5)
      .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
    return near != null && Math.abs(near - ideal) < targetSec / n / 2 ? near : ideal;
  }).sort((a, b) => a - b);
  const bounds = [0, ...cuts, targetSec];
  return Array.from({ length: n }, (_, i) => ({
    shot: i,
    start: Math.round(bounds[i] * 100) / 100,
    end: Math.round(bounds[i + 1] * 100) / 100,
    snapped: i < n - 1 && onsets.length > 0 && cuts[i] !== even[i],
  }));
}

// lib/edit/trending.js — Instagram Audio API adapter: pulls TRENDING audio into
// the local library so reels can be cut/previewed against it and the download's
// upload-instruction can name the exact sound the customer attaches natively.
//
// Endpoint (verified against Meta docs 2026-07-04):
//   GET https://graph.facebook.com/<ver>/ig_audio
//     ?audio_type=music|original_sound  (required)
//     &user_id=<IG_AUDIO_USER_ID>        (required)
//     &access_token=<token>              (required; User token, scopes
//                                          instagram_basic + instagram_content_publish)
//     [&search_query=…]                  (OMIT → trending audio is returned)
//   → { data: [ { audio_id, title, display_artist, duration_in_ms, download_url,
//                 on_platform_audio_preview_link, is_ads_eligible, … } ] }
//   download_url is a TEMPORARY (~1.5d) preview we fetch for beat-analysis + the
//   gallery preview mux; on_platform_audio_preview_link is the "find it in-app"
//   URL we surface in the instruction. The published Reel would attach by audio_id,
//   but Phantom delivers silent + instructions (customer attaches natively), so we
//   only need the metadata + preview bytes here.
//
// IG_AUDIO_MODE=mock (default until a token+user are set) → deterministic fake
// trending items with an ffmpeg-synthesized clip, so the whole sync→cut→preview→
// instruction chain runs $0 with no Meta app.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import { audioTracks } from '../db.js';
import { storage } from '../storage.js';
import { logEvent } from '../logs.js';
import { FFMPEG } from './audio.js';

const GRAPH = () => (process.env.IG_AUDIO_BASE || 'https://graph.facebook.com').replace(/\/$/, '');
const VERSION = () => process.env.META_GRAPH_VERSION || 'v22.0';
const token = () => process.env.IG_AUDIO_ACCESS_TOKEN || '';
const userId = () => process.env.IG_AUDIO_USER_ID || '';
const mode = () => (process.env.IG_AUDIO_MODE || (token() && userId() ? 'live' : 'mock')).toLowerCase();
export const isMock = () => mode() === 'mock';

// Normalize one API item to our track shape.
function normalize(item, audioType) {
  return {
    audio_id: item.audio_id || item.id || null,
    title: item.title || 'Untitled sound',
    artist: item.display_artist || item.ig_username || null,
    duration_sec: item.duration_in_ms ? Math.round(item.duration_in_ms / 1000) : null,
    download_url: item.download_url || item.on_platform_audio_preview_link || null,
    source_url: item.on_platform_audio_preview_link || null,
    ads_eligible: item.is_ads_eligible === true,
    audio_type: audioType,
  };
}

// Deterministic mock trending list + a synthesized clip per item (so a real
// assemble downstream has decodable audio to cut against).
function mockTrending(limit, audioType) {
  const seeds = [
    { title: 'Golden Hour', artist: 'aeon', ads: true, freq: 210 },
    { title: 'Midnight Drive', artist: 'nova', ads: true, freq: 180 },
    { title: 'Sun Faded', artist: 'lull', ads: false, freq: 240 },
    { title: 'Paper Planes', artist: 'koto', ads: true, freq: 160 },
  ];
  return seeds.slice(0, limit).map((s, i) => ({
    audio_id: `mock-ig-${audioType}-${i}`,
    title: s.title, artist: s.artist,
    duration_sec: 14,
    download_url: `mock://clip/${i}/${s.freq}`,
    source_url: `https://www.instagram.com/reels/audio/mock-${audioType}-${i}/`,
    ads_eligible: s.ads, audio_type: audioType,
    _mockFreq: s.freq,
  }));
}

// fetchTrending → normalized items (no search query = trending).
export async function fetchTrending({ audioType = 'music', limit = 8, searchQuery = null } = {}) {
  if (isMock()) return mockTrending(limit, audioType);
  const qs = new URLSearchParams({ audio_type: audioType, user_id: userId(), access_token: token(), limit: String(limit) });
  if (searchQuery) qs.set('search_query', searchQuery);
  const url = `${GRAPH()}/${VERSION()}/ig_audio?${qs.toString()}`;
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    throw new Error(`ig_audio ${r.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
  }
  return (data.data || []).map((it) => normalize(it, audioType));
}

// Download the preview bytes for one item into a temp file (real URL or mock synth).
async function fetchClip(item, destPath) {
  if (isMock() || String(item.download_url || '').startsWith('mock://')) {
    const freq = item._mockFreq || 200;
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', `sine=frequency=${freq}:duration=${item.duration_sec || 14}`,
      '-af', "volume='if(between(t,2,2.4)+between(t,5,5.4)+between(t,8,8.4),1.0,0.08)':eval=frame",
      '-b:a', '128k', destPath]);
    if (r.status !== 0) throw new Error('ffmpeg mock-clip synth failed');
    return;
  }
  const resp = await fetch(item.download_url);
  if (!resp.ok) throw new Error(`download_url ${resp.status} for "${item.title}"`);
  fs.writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()));
}

// syncTrendingToLibrary — fetch trending, download each clip into the library, add
// an audio_tracks row (source='trending_ig'). Business content: prefer ads-eligible
// sounds. Idempotent by source_url (skips ones already synced).
export async function syncTrendingToLibrary({ audioType = 'music', limit = 8, adsOnly = false } = {}) {
  const items = await fetchTrending({ audioType, limit });
  const existing = new Set(audioTracks.list().map((t) => t.source_url).filter(Boolean));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-trending-'));
  const out = { fetched: items.length, added: 0, skipped: 0, ids: [] };
  try {
    for (const item of items) {
      if (adsOnly && !item.ads_eligible) { out.skipped++; continue; }
      if (item.source_url && existing.has(item.source_url)) { out.skipped++; continue; }
      const clip = path.join(work, `${crypto.randomBytes(6).toString('hex')}.mp3`);
      try {
        await fetchClip(item, clip);
      } catch (e) {
        logEvent({ level: 'warn', event: 'trending.clip_failed', message: `${item.title}: ${e.message}` });
        out.skipped++; continue;
      }
      const key = storage.makeKey('library', 'audio', 'mp3');
      await storage.put('library', key, fs.readFileSync(clip), 'audio/mpeg');
      const id = audioTracks.add({
        title: item.title, artist: item.artist, source: 'trending_ig',
        sourceUrl: item.source_url,
        licenseNote: `Instagram trending${item.ads_eligible ? ' · ads-eligible' : ''} · attach natively, do not distribute · ig_audio:${item.audio_id}`,
        r2Key: key, durationSec: item.duration_sec,
        vibeTags: ['trending', item.audio_type, ...(item.ads_eligible ? ['ads-safe'] : [])],
      });
      out.added++; out.ids.push(id);
      if (item.source_url) existing.add(item.source_url);
    }
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  logEvent({ event: 'trending.synced', message: `${mode()} ${audioType}: +${out.added} (${out.skipped} skipped of ${out.fetched})` });
  return { mode: mode(), ...out };
}

export default { isMock, fetchTrending, syncTrendingToLibrary };

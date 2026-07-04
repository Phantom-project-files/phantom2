// lib/edit/instructions.js — the per-piece "upload instructions" that ship in the
// download ZIP next to each silent master.
//
// Why this exists: reels are cut to a trending track and previewed WITH it in the
// gallery, but the downloadable file is SILENT — the customer adds the sound
// natively in the app (trending/commercial audio can't be legally baked into
// distributed business content). The instruction file tells them exactly which
// sound to add, where to find it, and that the cut is already beat-synced so they
// just start the sound at 0:00. Posts get a caption/hashtag sheet.
//
// Pure string builders — no I/O. Consumed by the download.zip route.

function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return null;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// audioInstruction shape (written by assemble.js into the reel asset meta):
//   { track_title, track_artist, source_url, start_sec, cut_times: [sec,...] }
export function buildReelInstruction({ piece, brief = {}, audioInstruction = null, mediaFileName }) {
  const lines = [];
  lines.push('PHANTOM — Reel upload instructions');
  lines.push(`Scheduled day: ${piece.scheduled_date}`);
  lines.push('');
  lines.push(`1. Post "${mediaFileName}" as a Reel (it has no sound on purpose).`);

  if (audioInstruction && audioInstruction.track_title) {
    const by = audioInstruction.track_artist ? ` by ${audioInstruction.track_artist}` : '';
    lines.push(`2. Add this sound in the app: "${audioInstruction.track_title}"${by}`);
    if (audioInstruction.source_url) lines.push(`   Find it: ${audioInstruction.source_url}`);
    else lines.push(`   Find it: search "${audioInstruction.track_title}"${by} in the in-app audio picker.`);
    const cuts = (audioInstruction.cut_times || []).map(fmtTime).filter(Boolean);
    const startTxt = fmtTime(audioInstruction.start_sec) || '0:00';
    lines.push(`3. The video is already cut to the beat — start the sound at ${startTxt}.`);
    if (cuts.length) lines.push(`   Scene changes land at: ${cuts.join(', ')}.`);
  } else {
    lines.push('2. Add a trending sound of your choice — the cuts sit on a steady beat, so start it at 0:00.');
  }

  const caption = [brief.caption, brief.cta].filter(Boolean).join('\n');
  if (caption) { lines.push(''); lines.push('Caption:'); lines.push(caption); }
  lines.push('');
  return lines.join('\n');
}

export function buildPostInstruction({ piece, brief = {}, mediaFileName }) {
  const lines = [];
  lines.push('PHANTOM — Post upload instructions');
  lines.push(`Scheduled day: ${piece.scheduled_date}`);
  lines.push('');
  lines.push(`1. Post "${mediaFileName}" as a feed image.`);
  const caption = [brief.caption, brief.cta].filter(Boolean).join('\n');
  if (caption) { lines.push('2. Caption:'); lines.push(caption); }
  lines.push('');
  return lines.join('\n');
}

# Runbook — Audio library (PLAN.md post-build item 6)

Written 2026-07-03 after end-to-end verification at $0: three synthetic beat tracks
(ffmpeg-generated, distinct tempos) were pushed through the real admin upload route,
vibe-matched against a live brief, and consumed by the real beat-cut assembly of
piece 151 (live-prod-co-2bgw) — the reel that previously logged `track=none` picked
the right track, snapped its visual cut to a detected drop (5.30 s, on the 124 BPM
grid), and shipped an AAC audio stream. All synthetic tracks and test reels were
removed afterward; **the library is empty by design until you upload real tracks.**

Code surface: `backend/lib/edit/audio.js` (selection + onset detection),
`backend/lib/edit/assemble.js` (consumption), `POST/GET /api/admin/audio` in
`backend/server.js`, `audio_tracks` table in `backend/lib/db.js`.

## Licensing (YOUR open decision — the code doesn't care)

- The editor is **audio-source-agnostic** by design (operator decision 2026-07-02):
  it plays whatever is in `audio_tracks`. Where the rights come from is recorded per
  track in `license_note` and is entirely your problem to solve — licensed catalog,
  commissioned work, AI-gen, anything rights-cleared works.
- **No YouTube ripping — standing product decision, not a technical gap.** Copyright
  liability in a commercial product, and API-published business accounts don't get
  trending commercial audio anyway (baked-in tracks get muted/removed by the
  platforms). Don't ask the tooling to do it; it will refuse.
- Until you upload tracks, reels assemble **silent** with an honest
  `no_audio: track library empty — reel assembled silent` flag in the asset meta.
  Nothing blocks; nothing pretends.

## What to upload

- **Format:** MP3 is the storage contract — the route stores bytes verbatim under an
  `.mp3` key with `audio/mpeg` content-type regardless of what you send, so send
  actual MP3 (44.1 kHz, 128 kbps+ is plenty; the reel re-encodes to AAC 128k mono-safe).
- **Duration:** reels are ≤18 s (≤3 shots × 6 s), and the track is laid from its
  start with `-shortest` + a 1 s fade-out. Anything ≥20 s works; 30–90 s is the sweet
  spot. Onset analysis reads at most the first 180 s, so radio edits are fine and
  10-minute mixes are wasted bytes (25 MB upload cap).
- **Musical content:** cut-snapping runs on energy-flux onsets — it needs real
  transients (kick drums, drops, stabs) in the opening ~20 s. Percussive tracks snap
  beautifully; beatless ambient pads detect nothing and cuts fall back to even
  splits (still correct, just not beat-locked).

### Sanity-check a track before upload (one-liner)

```sh
ffprobe -v error -show_entries format=duration -show_entries stream=codec_name,sample_rate,bit_rate -of default=noprint_wrappers=1 track.mp3
```

Expect `codec_name=mp3`, `sample_rate=44100` (or 48000), and a sane `duration`.
If ffprobe errors, the assembler's decoder will too — fix the file first.

## How to upload

There is **no console Audio panel yet** — the console (`public/app/admin.html`) has
no audio section; PLAN item 6's "console → Audio panel" UI is still to be built.
The API route is live and is the real ingestion path (verified 2026-07-03):

```sh
# 1. log in (any browser session works too — the cookie is what matters)
curl -c /tmp/phantom.jar -X POST http://localhost:3020/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<ADMIN_USERNAME>","password":"<ADMIN_PASSWORD>"}'

# 2. upload — metadata rides the query string, the body is the raw mp3 bytes
curl -b /tmp/phantom.jar -X POST \
  "http://localhost:3020/api/admin/audio?title=Summer%20Heat&artist=Artist&license=Licensed%20via%20XYZ%20catalog%2C%20invoice%20%23123&vibe=upbeat,summer,pop" \
  -H 'Content-Type: audio/mpeg' --data-binary @track.mp3

# 3. confirm
curl -b /tmp/phantom.jar http://localhost:3020/api/admin/audio
```

- `title` is required; `artist` optional; **always fill `license`** — it's your
  rights paper-trail (`license_note` column).
- `vibe` is comma-separated tags — this is what selection matches on (below).
- Files land in storage under the shared `library` namespace
  (`tenants/library/audio/<yyyy>/<mm>/…`), not per-tenant: one library serves all brands.
- There is no delete route yet; retiring a track means deleting its `audio_tracks`
  row (and optionally the storage object) by hand.

## How a track gets picked (tag your library accordingly)

Every reel brief carries a free-text `audio_vibe` (e.g. `"upbeat summer pop"`,
written by script-gen). Selection (`pickTrack` in `lib/edit/audio.js`) is cheap
token overlap: the vibe is split into lowercase words and each track scores +1 per
word that appears in its `vibe_tags`. Highest score wins; ties go to the
**lowest id (oldest upload)**. There is no minimum score — with a non-empty library
a track is *always* chosen, even at score 0. Practical consequences:

- Tag with **simple single words** (`upbeat`, `chill`, `luxury`, `pop`, `summer`,
  `energetic`, `moody`, `cinematic`) — multi-word tags only match word-by-word anyway.
- Cover the moods script-gen actually writes; a library that's all `chill` will get
  slapped onto `energetic` briefs at score 0. Verified live: `"upbeat summer pop"`
  picked the `upbeat,summer,pop,energetic` track (score 3) over `chill,lofi,calm`
  and `hype,edm,workout` alternatives; a `"chill lofi study"` vibe flipped to the
  chill track.
- 5–10 well-tagged tracks across 3–4 moods beat 100 untagged ones.

## What happens downstream (so you can read the meta)

Assembly (`assemble_reel` job) runs onset detection on the picked track (50 ms
RMS energy-flux, peaks ≥ mean+1.5σ, ≥0.8 s apart), then snaps shot transitions to
the nearest drop within reach — capped by what each ~6 s source shot can actually
deliver (`maxSegSec`, fix landed 2026-07-03: a cut snapped *past* the end of a shot
used to be silently truncated off-beat by ffmpeg). The reel asset's meta records
the receipts: `track_id`, `track_score`, `onsets_used`, and `edit_plan` with a
`snapped: true` on every beat-locked cut. `track_id: null` + a `no_audio` flag
means the library was empty when that reel assembled — re-assembly after upload
will pick a track.

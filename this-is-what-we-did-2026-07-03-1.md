# this-is-what-we-did — 2026-07-03 — session 1

## Context at open
- Repo at v0.9.0, clean tree, HEAD = 211c86d (session-close docs commit).
- ALL 8 BUILD PHASES COMPLETE as of 2026-07-02. Smoke was 98/98.
- What remains is the post-build operator checklist (docs/PLAN.md):
  1. Fal.ai — fund + verify nano-banana/seedance schemas (1 phantom + 1 reel + 1 post first)
  2. Rotate Claude + Fal keys
  3. Google OAuth client → GOOGLE_CLIENT_ID/SECRET
  4. Stripe live keys + webhook secret
  5. Fly app `phantom2` + volume + R2 bucket + secrets
  6. Rights-cleared audio tracks w/ vibe tags
  7. Remotion compositions scaffold
  8. Domain cutover online-phantom.com → phantom2

## This session
### Checklist item 1 — Fal.ai schema verification (via Chrome, $0, no funded calls)
Pulled fal's own OpenAPI (`fal.ai/api/openapi/queue/openapi.json?endpoint_id=…`) for every
model we pin, plus model pages for pricing. Three real mismatches found + fixed:
1. **`image_urls` on t2i would have failed** — `fal-ai/nano-banana-pro` (text-to-image) has no
   `image_urls` field; it lives on `fal-ai/nano-banana-pro/edit` where it's *required*.
   → `MODELS.imageEdit` added (`$FAL_IMAGE_EDIT_MODEL`); render_post + reel keyframes pick
   `imageEdit` when a phantom ref URL exists, plain `image` otherwise. Phantom face render
   stays pure t2i.
2. **Video model id didn't exist** — `fal-ai/bytedance/seedance-2.0` → 404. Real id:
   `bytedance/seedance-2.0/image-to-video` (no `fal-ai/` prefix). Default swapped.
3. **`duration` type** — seedance wants string enum `"4".."15"`, we sent int `6` →
   `String(VIDEO_SECONDS())`. Also: `generate_audio: false` (defaults TRUE — would bake
   lip-sync/SFX into shots that get music from the operator library at edit time) and
   `resolution` pinned via `FAL_VIDEO_RESOLUTION` (default 720p).
Plus: price estimate defaults corrected to published pricing — image $0.15 (was 0.04),
video $0.3034/sec @720p (was 0.125). Aspect ratios all confirmed in-enum (1:1, 4:5, 9:16).
Output shapes confirmed (`images[].url` / `video.url`) — `firstMediaUrl()` already handles both.
SSRF allowlist: `v3b.fal.media` matches via subdomain rule; noted `storage.googleapis.com`
fallback in PLAN if live ingest ever blocks.
- Smoke after changes: **ALL PASS** ✅ (mock mode exercises the new imageEdit path since
  mock phantom refs are truthy).
- What still needs the operator: fund Fal, then the 1-phantom + 1-reel + 1-post live run.

### Checklist item 1 — FIRST FUNDED RUN ✅ (operator added $18.48)
Two more live-only bugs caught and fixed during the run:
4. **Queue reads 405'd on subpath endpoints** — status/result for `fal-ai/nano-banana-pro/edit`
   requests must be read at the BASE app path (`fal-ai/nano-banana-pro/requests/<id>/…`);
   polling the full subpath returns 405 forever while the request sits COMPLETED.
   → `basePath()` in lib/fal.js (first two id segments) for all read calls.
5. **Local storage refs were unfetchable by Fal** — local-backend signedGet returns an
   in-process RELATIVE path (`/api/media/local/<token>`); Fal got that as `image_urls` and
   the gen failed 422 "could not generate with given prompts and images".
   → `storage.fetchableUrl()`: R2 https URLs pass through; local bytes inline as data URIs
   (Fal file inputs accept data URIs). render.js phantom-ref + keyframe call sites switched.
   Prod on R2 was never affected.
**Live results (tenant live-prod-co-2bgw, all real bytes, zero failed jobs at close):**
- Phantoms 7 Maya + 10 Leo → ready (~30 s each, t2i)
- Post 154 → ready in ~40 s (edit w/ phantom ref via data URI + stat_card compose)
- Reel 151 → ready: 2 edit keyframes → 2× Seedance 6 s shots (~3–4 min each, the slow leg)
  → beat-cut assembly → final 4.2 MB mp4 (renders/2026/07/ca-stR8XtIOyPR9Hi--NssPY.mp4)
- Ledger: $4.39 estimated spend (2× face 0.15, post 0.15, 2× keyframe 0.15, 2× shot 1.82).
  3 dead-422 edit requests from the pre-fix attempt should not bill (fal charges successes).
- .env: MOCK_MEDIA_GEN=0, FAL_VIDEO_MODEL fixed to bytedance/seedance-2.0/image-to-video.
- New: scripts/live-first-run.js (targeted 1-phantom-pair + 1-reel + 1-post enqueuer).

### Checklist item 2 — KEY ROTATION ✅
- Audit first: the Anthropic + Fal keys in `~/Downloads/Phantom2.0.env.rtf` were EXACTLY the
  live `.env` keys (hash-compared). Only 2 copies on disk; `.env` never in git history; v1
  project clean; Stripe keys in the rtf were test-mode (rotate at launch w/ item 4 anyway).
- Operator rotated both in their dashboards. Verified live ($0 GETs): new Anthropic key 200 /
  old 401 (dead); new Fal key 200 (prefix matches the single "Phantom" key in the dashboard,
  created today). Old Fal key still answered 200 minutes after deletion — fal edge revocation
  propagates slowly; dashboard shows it gone, operator confirmed revoked, moved on.
- Hygiene: `.env` chmod 600; rtf moved to Trash by operator; scratchpad copies shredded;
  admin password flagged for rotation before prod (also in the plaintext file).
- Server restarted on rotated keys, boot clean.
- BONUS ground truth: fal dashboard credits $14.07 after the run → actual billed $4.41 vs
  our ledger estimate $4.39 (2¢ off) — estimate math is trustworthy, dead 422s not billed.

### Checklist item 7 — Remotion compositions SCAFFOLDED ✅ (background agent, reviewed + verified)
- Repo-root `remotion/` project (pinned 4.0.484, own node_modules — nothing enters backend
  deps or the Fly build context). Compositions: EndCard (mirrors chrome card design),
  InfographicOverlay, MotionCurveAccents, ChalkEffect (all 9:16 alpha overlays) + PostStill
  (4:5 still). All brand content via inputProps. NO caption composition — removed by design,
  Root.tsx carries the do-not-add comment.
- `lib/edit/remotion.js` boundary: lazy createRequire, bundle cached per process, ProRes 4444
  alpha + muted overlays (agent caught two real bugs live: `proResProfile` casing; Remotion's
  silent PCM track stealing ffmpeg stream selection from the music bed).
- graphics.js: remotion-first when REMOTION_ENABLED=1, any error → logged fallback to
  chrome_overlay — graphics polish can never sink a reel. Flag unset = byte-identical path.
- Independently re-verified after agent handoff: smoke ALL PASS + verify-remotion.js
  (EndCard 4.4MB alpha .mov, PostStill 1080x1350 png). Post-compose wiring to PostStill
  deliberately deferred.
- Note: agent reports smoke.js currently carries 87 checks (yesterday's log said 98) — the
  suite passes clean either way; count discrepancy noted, not chased.

### Checklist item 3 — Google OAuth (in flight)
- Operator created GCP client + put GOOGLE_CLIENT_ID/SECRET in .env; server restarted.
- First attempt: redirect_uri_mismatch (localhost URI missing on the client) → operator
  added `http://localhost:3020/auth/google/callback` → account chooser now renders with
  correct scopes (openid email profile) + state cookie. Awaiting operator click-through;
  users-table watcher armed to verify the callback upsert.

### Checklist item 3 — Google OAuth ✅ VERIFIED END-TO-END
Three sequential failures diagnosed live, each one layer deeper (this is the debugging record):
1. `redirect_uri_mismatch` at Google — localhost redirect URI wasn't registered → operator added
   `http://localhost:3020/auth/google/callback` (exact string; http, port, no trailing slash).
2. "state cookie missing or expired" at our callback — STATE_TTL_SECONDS=600 is a 10-min
   anti-CSRF window and the URI fix outlasted it. Working as designed; re-ran /start.
3. "token exchange failed" HTTP 401 — paste typo in .env: line read `OGLE_CLIENT_SECRET=`
   (leading GO eaten), so the exchange went out with an empty secret. sed'd the var name,
   restarted.
Final run: start → account chooser → consent → callback → **users row (Vaibhav Mathur,
google_sub set) + user_sessions row + org auto-created + redirect to ?next target** ✓.
COMING_SOON gate note: /auth/google/start is gated for anon; the admin cookie bypasses in
dev. Customer flow opens when the gate drops.

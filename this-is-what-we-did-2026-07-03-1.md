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

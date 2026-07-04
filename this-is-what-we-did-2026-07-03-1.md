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

### Checklist item 4 — Stripe live prep ✅ TEST-MODE VERIFIED + RUNBOOK
- Mapped the surface: ONE API call (`POST /v1/checkout/sessions`, inline price_data — no
  dashboard Products/Prices), ONE webhook event consumed (`checkout.session.completed`),
  route `POST /webhook/stripe` (raw-body mount before express.json). No stripe npm pkg —
  hand-rolled REST + v1 HMAC verify; nothing version-pinned, nothing version-sensitive.
  STRIPE_PUBLISHABLE_KEY is read NOWHERE (hosted-checkout redirect, no Stripe.js).
- $0 offline verification (scratch DB via PHANTOM_DB_PATH, dummy whsec, zero Stripe calls):
  25/25 — good sig accepted, bad/tampered/stale(>300s)/missing/malformed rejected,
  timingSafeEqual length guard holds, `checkout.session.completed` flips intake→paid,
  purchase→paid, enqueues script_gen + payment_confirmed email, records funnel.paid;
  client_reference_id fallback works; foreign event types ignored gracefully.
- Live server probe (no restart): unsigned POST accepted with `webhook_unsigned` warn —
  as designed for dev (.env has no STRIPE_WEBHOOK_SECRET).
- **Security fix landed:** verifyStripeSignature used to fail OPEN with no secret in ANY
  env; /webhook/stripe is gate-allowlisted, so a forgotten prod secret = anyone can POST
  a fake checkout.session.completed and unlock any intake. Now refuses unsigned when
  NODE_ENV=production. New smoke check covers it — smoke ALL PASS (88).
- `docs/runbooks/stripe-live.md`: dashboard steps (activate → live keys → webhook endpoint
  `https://online-phantom.com/webhook/stripe`, ONLY checkout.session.completed, copy whsec)
  + `fly secrets set` + stripe-CLI localhost rehearsal (`stripe listen --forward-to
  localhost:3020/webhook/stripe`) + post-deploy checks + known limits (subs never revoke;
  single-v1 check during secret rolls).

### ADMIN_PASSWORD rotated ✅
New random 24-char value in .env (env is the credential source); old password's bcrypt hash
in the admins table NULLed (path-2 fallback would have kept accepting it); all 10
admin_sessions revoked; server restarted. Operator reads it via `grep ADMIN_PASSWORD .env`.

### Item 5 — R2 half CLOSED via v1 reuse ✅ (operator decision: no new bucket)
Operator pasted... actually only R2_BUCKET_PROD landed; the three credential values were
empty. Copied R2_ACCOUNT_ID / keys from 000_Phantom/backend/.env per operator instruction.
First roundtrip 403 AccessDenied — v1 token is scoped to bucket `phantom-prod`, .env said
`phantom2-prod` → repointed to `phantom-prod` (keys are tenants/<slug>-namespaced; v1 and
2.0 objects coexist). Verified: put + stat + signed GET 200 + delete. Remaining item-5 work
is just `DRY_RUN=0 scripts/provision-phantom2.sh` when ready to deploy (Fly already authed).

### Items 4/5/6 subagent consolidation ✅ (3 parallel agents, all landed, smoke ALL PASS)
- **Stripe (4):** fail-open webhook bug FIXED (unsigned events now refused in
  NODE_ENV=production — was: forgetting STRIPE_WEBHOOK_SECRET in prod = anyone POSTs a fake
  checkout.session.completed through the gate-allowlisted route and unlocks a free run).
  25/25 offline signature+state checks. No SDK, hosted Checkout w/ inline price_data;
  STRIPE_PUBLISHABLE_KEY read nowhere. Only event consumed: checkout.session.completed.
  Known limitation documented: subscription cancellations never auto-revoke. Runbook:
  docs/runbooks/stripe-live.md. OPERATOR DECISION: stays test-mode until go-live.
- **Fly/R2 (5+8):** fly.toml FIXED (PUBLIC_BASE_URL was missing → Fal webhooks would have
  been silently disabled in prod, the v1 stranded-pipeline failure); .dockerignore FIXED
  (secrets.prod.env would have been baked into the image). Dockerfile audited clean
  (ffmpeg+chromium in, port/volume/DB aligned). scripts/provision-phantom2.sh (DRY_RUN=1
  default, dry-run verified), secrets.prod.env.example (12-secret manifest),
  docs/runbooks/domain-cutover.md. flyctl authed as vaibhav@fallacie.com.
- **Audio (6):** pipeline PROVEN at $0 — 3 synthetic tracks through the real HTTP upload
  route, vibe-tag pickTrack correct both directions, piece 151 re-assembled through the
  live job queue w/ AAC + 24 onsets, then FULLY cleaned (151's silent original restored).
  Two real bugs fixed: off-beat cut truncation (maxSegSec clamp — cut now lands exactly on
  a detected beat) and the scratch-suite storage leak (PHANTOM_MEDIA_ROOT isolation; found
  41 orphan mp3s + 42 leaked scratch dirs from past runs). GAP: no console Audio panel —
  API route is the only ingestion path. Runbook: docs/runbooks/audio-library.md.
- .env.example stale seedance id fixed (flagged by fly agent).

### Item 6 — TRENDING AUDIO: solution designed (operator asked for a rethink)
Core fact that resolves the confusion: NO API can attach native trending audio to a reel
(Meta doesn't expose it) — and baked commercial audio gets muted on business accounts. So
audio must travel with the EDIT, not the file. TWO-LANE MODEL:
- **Lane A (built today):** rights-cleared library audio baked in → reels+posts fully
  auto-publish. Default for hands-off tiers.
- **Lane B (to build):** trending track stored as trending_ref (title/artist/IG-audio link
  + operator-sourced snippet used ONLY for beat analysis + preview). Beat-cut edits reel to
  the snippet's grid → SILENT master + sync metadata (start offset, cut times). Gallery
  plays a streaming-only preview mux (never in ZIP). Deliverable = silent master + auto-
  generated instruction card ("Add audio '<track>' → trim to 0:07; cuts at 0.0/2.4/4.8s").
  Deploy policy: posts auto-publish; Lane-B reels NEVER auto-publish — delivered as drafts
  w/ instruction card (native attach is the only way the reel counts toward the trend).
  Build list: audio_tracks.kind + trend metadata; assemble silent+preview path; gallery
  preview player + instruction card + ZIP; deploy_piece draft guard. NOT BUILT YET —
  awaiting operator go.

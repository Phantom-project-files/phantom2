# Phantom 2.0 — Session Log · 2026-07-02 · #1

> **Living doc** (protocol carried from v1): updated every prompt, committed + pushed to `main` each turn.
> Repo: `Downloads/000_phantom2.0` → GitHub `Phantom-project-files/phantom2` (private).
> v1 session logs live in the old repo; 2.0 logs live here from now on.

---

## TL;DR (current state)
- **Phase 0 (foundation) BUILT + VERIFIED, $0.** Spec review happened earlier this session
  (logged in the v1 repo's `this-is-what-we-did-2026-07-02-1.md`); operator said **start** and made
  two calls: (1) **2.0 supersedes v1** — no more v1 bug work; (2) music via YouTube-ripping was
  **declined** (copyright liability + API-published business accounts can't use trending audio
  anyway) → the beat-cut editor is **audio-source-agnostic**, fed by an operator-supplied
  rights-cleared library (`audio_tracks` + R2). Operator keeps hunting a licensing solution.
- **What exists now:** Express backend boots clean — coming-soon gate + lock → operator login →
  2.0 console (system badges, jobs queue, spend, user-journey events, phase tracker).
  Smoke test: **14/14 PASS** (auth, events, jobs happy/retry/billing-halt, llm mock, storage
  tenant-guard, fal mock). HTTP surface verified via curl (gate serves coming-soon HTML to pages,
  JSON 503 to APIs; beacon 204; login → authed console).
- **Dev login (local only):** `vmathu20` / `tuensurRGr0UddBB` (in `backend/.env`, gitignored).

## Phase 0 inventory
- **Ported from v1 verbatim** (proven): `lib/safety.js`, `lib/logs.js`, `lib/storage.js`
  (r2|local, tenant-prefix assertion), `middleware/requireAdmin.js`, `admin/auth-routes.js`,
  `coming-soon.html`, `admin-login.html` (repointed to admin.html, phantom.js include dropped),
  `phantom.css` + logo, privacy/terms.
- **New — `lib/db.js` + `migrations/001_init.sql`:** admins/admin_sessions/logs (v1 shapes) +
  2.0 tables: `orgs`/`users`/`user_sessions` (OAuth-ready), **`events`** (user-journey stream —
  the "nothing records what users do" fix; also the future agent-email trigger stream),
  **`jobs`** (queue), `cost_events`, `media_assets`, `audio_tracks`.
- **New — `lib/jobs.js`:** SQLite-backed worker, **per-kind concurrency caps** (v1 stampede fix),
  restart-safe (orphans requeued at boot — v1 stranded-faces fix), exponential backoff retries,
  **billing circuit-breaker** (billing-class error fails the job AND halts queued siblings of the
  same kind+tenant — the Enhancor-401 lesson).
- **New — `lib/llm.js`:** single LLM boundary. `CLAUDE_MODE=mock` (DEFAULT — spend is opt-in) |
  **`claude_code`** (operator's local logged-in Claude Code CLI = Max subscription, $0 API; prompt
  via stdin, `--output-format json`) | `anthropic_api` (prod). Task-tier model routing per the BPMN
  sticky notes: synthesis→Opus, extraction→Sonnet, summary→Haiku (env-overridable). Safety preamble
  on every call; schema validation with one retry; cost ledger rows (anthropic real $, claude_code $0 markers).
- **New — `lib/fal.js`:** Fal queue client scaffold. Model ids config-pinned
  (`FAL_IMAGE_MODEL`=nano-banana-pro, `FAL_VIDEO_MODEL`=seedance-2.0 — verify exact ids in Phase 4),
  webhook-first submit, `classifyError()` feeds the billing breaker, `MOCK_MEDIA_GEN=1` default.
- **New — `server.js`:** gate (allowlist incl. `/webhook/` + `/api/events`), events beacon
  (`POST /api/events`, anonymous `ph_sid` cookie, rate-limited), admin APIs (status / jobs / events
  / costs / logs summaries), fal webhook stub, local-media streamer, no-cache HTML/JS/CSS (v1 edge-
  cache lesson), JSON error handler, hourly session purge.
- **New — console shell `public/app/admin.html`:** mode badges (claude/media/storage/gate),
  jobs + spend + events panels (10s auto-refresh), build-phase tracker, version stamp.
- **Deploy scaffolding (not deployed):** `Dockerfile` (node:22-slim; ffmpeg+chromium arrive Phase 5),
  `fly.toml` (app `phantom2`, `/data` volume, **2 vCPU / 2 GB** — v1's stampede died on 1 GB).
- **Docs:** root `README.md`, `docs/PLAN.md` (phases 0–8 + decision log), BPMN sheets moved to
  `docs/bpmn/`.
- **Keys:** `backend/.env` (gitignored) seeded from `Phantom2.0.env.rtf` (Claude, Fal, Stripe test).
  ⚠️ Rotate Claude + Fal keys before launch — they sat in plaintext in Downloads.

## Verification log
- `npm run smoke` → 14/14 ✅ (scratch DB; admin upsert/session, events count, llm mock, storage
  put/signedGet + cross-tenant block, fal mock submit + billing classify, job done-with-result,
  billing job fails + siblings halted, retry requeued with backoff, cost row, halt logged).
- Server boot + curl: `/health` ok, `/version` 0.1.0, `/` = coming-soon, unauth `/app/admin.html` =
  coming-soon, unauth `/api/*` = **503 JSON** (fixed: was serving HTML to curl due to `Accept: */*`),
  beacon 204 + event lands in admin summary, login sets cookie, authed console renders.

## Phase 1 — Agent-Scraper BUILT + VERIFIED (same session) → v0.2.0
- Operator created GitHub **`Phantom-project-files/phantom2`** → pushed; remote wired.
- **Migration 002:** `tenants` (slug minted at intake, v1 `name-xxxx` pattern), `intakes`
  (status/scrape_key/llm_calls/flags), **`scrape_sources`** — one row per source with honest status
  `scraped | partial | blocked_needs_apify | not_found | skipped | failed` (the "flag it so I can
  acquire Apify" system).
- **`lib/scrape/fetcher.js`** — v1-ported ladder (browser-UA → honest-bot-UA), `detectBlocked`
  (Cloudflare challenge / captcha / JS-shell heuristics), `discoverPages` (nav-link categorization:
  about/products/faq, bounded `SCRAPE_MAX_PAGES`=6), deterministic extraction (meta/og, headings,
  images, logo, social handles incl. spotify/soundcloud, tech hints: shopify + music platforms,
  page text for LLM). `SCRAPE_OFFLINE=1` + `SCRAPE_FIXTURE_HTML` for $0 tests.
- **`lib/scrape/taxonomy.js`** — the BPMN sheet as code: 6 gated sections (about, target_market,
  products_services, brand_assets, competitors, vertical incl. apparel/music_artist branches), each
  `{tier, gate, prompt, schema, mock}` — extraction=Sonnet, synthesis=Opus, classify=Haiku;
  `assembleScrape()` = the Phase-3 script-gen input contract.
- **`lib/scrape/social.js`** — per-platform public probe (no LLM): og-metadata pull, follower-count
  regex, login-wall/JS-shell classification → honest statuses. YouTube channel-id (`UC…`) URL fix.
- **`lib/scrape/runner.js`** — jobs-queue handler (`scrape`, concurrency 2, restart-safe):
  crawl → deterministic → gated LLM passes (**`SCRAPE_LLM_CALL_BUDGET`**=10 cap) → probes →
  scrape.json → R2 `tenants/<slug>/scrapes/…` → intake patched + events + logs. `startIntake()`
  mints tenant+intake+job (shared by Phase-2 funnel later).
- **Console:** "Scraper sandbox" panel — name+website form → queue; intake list with per-source
  status chips (green/amber/red), flags line, scrape.json link. Storage kinds + fal ingest
  allowlist updated (`scrape/shot/audio`; `fal.media`).
- **Verified:** smoke now **23/23 PASS** (offline e2e: fixture → scraped, sections assembled from
  mock LLM, shopify+handles detected deterministically, budget counted, signed URL mints).
  **Real-internet run (LLM mock, $0): allbirds.com** → 6 pages via browser rung; IG **scraped**
  (public metadata, 515K followers); TikTok **blocked_needs_apify** (JS shell — correct honest
  flag); X/FB **partial** (og metadata); YouTube channel resolves post-fix; shopify=true; 18 imgs
  + logo; flag "needs Apify for deep data: tiktok". No server errors.

## Phase 2 — Funnel BUILT + VERIFIED (same session) → v0.3.0
- **Migration 003:** intakes gain value_prop/plan/payment_status/paid_at/org_id/claimed_user_id;
  new `purchases` table (stripe_session_id unique, mock_paid status for $0 tests).
- **`lib/tiers.js`:** BPMN pricing — Standard $800 one-time 30/30 · Premium $1000/mo 30/30 ·
  Ultra $2000/mo 60/90 · **Overkill $4000/mo 100/140 (sheet wins over v1's 100/200)** + display copy.
- **`lib/valueprop.js`:** `value_prop` job auto-chained after every scrape — one synthesis-tier call
  builds the BPMN's 3× 16:9 frames (who they are → social reality w/ real follower data → the
  Phantom fix); stored on the intake; rendered as styled HTML slides (no image spend in funnel).
- **`lib/payments.js`:** Stripe via 2 REST calls (no SDK) — checkout sessions (payment vs
  subscription per tier), webhook w/ HMAC signature verify (length-guard bug caught by smoke:
  malformed v1 sig crashed timingSafeEqual → would've been a prod 500), STRIPE_MODE=mock for $0.
  **`markIntakePaid()` = the single unlock path** (webhook, mock, admin override all funnel through).
- **`lib/email.js`:** agent-email skeleton — `email` job lane, EMAIL_MODE=mock default (logs +
  `email.sent` journey events; `email.skipped_no_recipient` when intake unclaimed), Resend impl
  ready behind RESEND_API_KEY. Stage triggers live: welcome_claimed (OAuth), proposal_ready,
  payment_confirmed.
- **`auth/google-routes.js`:** v1 OIDC port (3 fetches, state cookie CSRF) adapted to 2.0 claiming —
  user⇄org⇄intake⇄tenant at callback; `/api/me`; graceful `not_configured` redirect when no
  GOOGLE_CLIENT_ID. `middleware/requireUser.js` + `requireUserOrAdmin` (operator walks the funnel
  without Google creds).
- **Funnel pages** (all include `assets/track.js` journey beacon): index (get-started form) →
  proposal (scan animation → 3 frames) → plans (4 tier cards) → signup (Google CTA + not-configured
  fallback) → checkout (redirector) → checkout-success (confirm + poll entitlement).
- **Console:** intake rows show payment chip + **Override → paid** button (skip OAuth+Stripe,
  BPMN requirement); proposal link; "open funnel ↗".
- **Gate fix (live-test catch):** funnel APIs were registered BEFORE the COMING_SOON gate → anon
  could trigger scrape/LLM spend pre-launch. Moved behind the gate: anon → 503, admin → works,
  beacon/webhooks stay allowlisted. Verified over HTTP.
- **Verified:** smoke **33/33 PASS**; live HTTP run: intake → value prop over API → plan →
  **REAL Stripe test-mode session** (`cs_test_…` at checkout.stripe.com) → simulated webhook →
  `payment_status=paid`, entitled=true → second intake via **admin override** (ultra) → all 5
  funnel pages render → journey events show the whole trail (intake.created → scrape.completed →
  valueprop.ready → plan.selected → checkout.started → funnel.paid) → checkout auth wall 401.

## Phase 3 — Script-gen BUILT + VERIFIED (same session) → v0.4.0
- **Migration 004:** `phantoms` (6 per intake: name/age/persona/**appearance_prompt** locked for
  consistency/vibe/ref_image_key/synthetic=1), `campaigns` (title/type/concept/**visual_design**
  shared per cluster/moment/product_refs), `pieces` (campaign+phantom+kind+pillar+
  **scheduled_date**+**brief** JSON+regen_count for the QC max-3 cap). Calendar = pieces.scheduled_date.
- **`lib/moments.js`** — grounded moments feed for campaign types: deterministic season math
  (hemisphere-aware), curated fixtures (**FIFA WC 2026 Jun 11–Jul 19 — active now**, July 4, BFCM,
  holidays…), operator-extensible `MOMENTS_JSON`, business events from the scrape (drop cycles).
  LLM picks from real moments; never invents events.
- **`lib/scriptgen/index.js`** — the `script_gen` job: counts from plan (or **sandbox overrides**)
  → cast 6 phantoms (1 synthesis call, PHANTOM_FACE_CONSTRAINT in prompt) → ideate
  clamp((R+P)/6, 1..30) campaigns against moments (1 call) → **deterministic allocation** (largest-
  remainder: campaign splits, pillar split 40/25/20/15 over posts, phantoms round-robin, per-day
  quotas — Premium = exactly 1 reel + 1 post/day) → per-campaign briefs (1 extraction call each;
  reel: hook/beats/frame_prompts ≤3/video_description/audio_vibe/graphics_notes/caption/cta; post:
  post_prompt/design_prompt/caption/cta) → **atomic piece insert** + artifact → R2.
  Budget `SCRIPTGEN_LLM_CALL_BUDGET`=40 (premium ≈ 12 calls). Idempotent: proceeding wipes+rebuilds;
  auto-trigger guard skips if production exists. **`markIntakePaid()` now auto-enqueues script_gen**
  (BPMN: payment → scriptgen).
- **Console:** `production.html?intake=` — phantom cards, campaign list w/ type+moment tags,
  30-day calendar grid, pieces table w/ expandable briefs; admin intake rows link to it.
  `POST /api/admin/intake/:id/scriptgen {reels?, posts?, regenerate?}` = the operator's
  "choose the amount of reels for what brand" sandbox.
- **Verified:** smoke **48/48 PASS** (6 phantoms; 10 campaigns for 30/30; counts exact; guard
  blocks double-trigger; calendar 30×(1+1); pillars 12/8/6/4; phantoms all used; brief contracts;
  sandbox 4/2 regenerate; FIFA active on 2026-07-02 + summer). **Live HTTP (ultra):** override →
  auto script_gen → 6 phantoms / 25 campaigns / 60+90 pieces / 30 days at exactly 2+3 per day;
  sandbox 3/2 regenerate over HTTP; production page renders.
- NOTE: mock mode shows "Mock Campaign N" titles by design — flip CLAUDE_MODE=claude_code (local
  Max, $0 API) or anthropic_api for real creative through the same pipeline.

## Phase 4 — Media engine BUILT + VERIFIED (same session) → v0.5.0
- **Migration 005:** `media_assets.meta` (shots: {campaign_id, slot, source_piece_id}; keyframes;
  phantom refs). The **shot library** = media_assets kind='shot' grouped by campaign — Phase 5's
  beat-cut editor pulls siblings from here.
- **`lib/media/render.js`** — job kinds `render_phantom` / `render_reel` / `render_post` / `fal_poll`:
  - Phantom faces: appearance_prompt + v1's studio ref spec (white bg/black tee/neutral) →
    Nano Banana → R2 → `phantoms.ref_image_key`, status → ready.
  - Reels: frame_prompts (≤3) → keyframe (Nano Banana w/ phantom ref image) → **Seedance
    image→video** (9:16, `FAL_VIDEO_DURATION`=6s) → shot → R2. Reel waits on its phantom via
    retryable backoff (no page-poll stranding — v1 lesson).
  - **Shot reuse is ORDER-based** (first reel per campaign renders all frames; siblings render hero
    only) — the pool-based version had a TOCTOU race under concurrency that smoke caught (all reels
    saw an empty pool at kick). Premium 30 reels × 2 frames → **40 fresh + 20 reused (33% saved)**.
  - **`fal_poll` is the single execution path** — submit enqueues a poll carrying a continuation
    (`ingest_phantom` | `ingest_post` | `keyframe_to_video` | `ingest_shot`); **/webhook/fal merely
    accelerates the queued poll (run_after=0)** → webhook/poller can never double-ingest.
  - Cost ledger per gen (`FAL_PRICE_IMAGE_USD`=.04, `FAL_PRICE_VIDEO_SEC_USD`=.125 — env-tunable
    estimates); billing errors classify → jobs breaker halts tenant siblings.
- **Spend safety (v1's "dashboard click billed real money" lesson):** media gen NEVER auto-fires —
  console shows **`GET …/media-estimate`** (faces/shots/reused/posts + $ figure) and the operator
  clicks **Generate media** (`POST …/generate-media {phantoms, reels, posts}` — partial batches OK).
  `MEDIA_AUTOGEN=1` exists for launch. Estimate for a full premium build ≈ **$33** at list prices.
- **Console:** production.html gains Generate button + live estimate, phantom face thumbnails,
  per-piece media links (shot0/shot1/post) via `GET /api/admin/media/:id/url` (302 → signed URL).
- **Verified:** smoke **56/56 PASS** ($0 mock chain: 6 faces w/ R2 keys; all pieces → ready; shot
  library 5 fresh for 4×2 frames; webhook acceleration; spend rows). **Live HTTP premium run:**
  estimate 40 fresh/20 reused → kick 6+30+30 → **6/6 faces, 60/60 pieces ready, 60 with media
  assets** in ~50s through the full submit→poll→continuation chain; media redirect serves bytes.
- ⚠️ Real-Fal input schemas (nano-banana / seedance field names) are best-guess until the first
  funded run — pinned in one place (`lib/media/render.js` submit inputs + `lib/fal.js` MODELS).

## Phase 5 — Edit layer BUILT + VERIFIED (same session) → v0.6.0
> Operator decision recorded: **Fal.ai setup (funding + input-schema verification) happens ONCE,
> after all phase builds are done** — now item #1 on the Post-build operator checklist in
> `docs/PLAN.md` (with keys rotation, Google creds, Stripe secret, Fly/R2, audio library, Remotion).
- **`lib/edit/audio.js`** — beat-cut brains: `pickTrack()` (vibe-tag overlap vs the operator's
  rights-cleared `audio_tracks` library — audio-source-agnostic by design), `detectCuts()` (ffmpeg
  → mono 16-bit PCM on stdout → 50ms windowed RMS → energy flux → peaks > mean+1.5σ w/ min-gap),
  `buildCutPlan()` (≤3 segments, transitions SNAP to nearest onset, even-split fallback).
- **`lib/edit/assemble.js`** — `assemble_reel` job (auto-chained when a reel's shots land):
  gathers own shots + **campaign-pool siblings for reused slots** (the reuse payoff) → track pick
  (empty library → assembles SILENT + `no_audio` flag, honest not blocking) → real ffmpeg: per-seg
  trim → 1080×1920 normalize → concat → track laid under w/ fade-out → graphics pass → R2
  kind='reel' with full edit_plan/track/shot-provenance meta.
- **`lib/edit/graphics.js`** — end-card via **chrome_overlay**: transparent PNG card rendered by
  headless Chrome, composited with ffmpeg's core `overlay` filter. Chose this AFTER real
  verification caught that **brew's ffmpeg ships without drawtext** (build-dependent filter);
  overlay is always present. Remotion = post-build item behind `REMOTION_ENABLED=1` (flags +
  falls back). Graphics failure NEVER drops a reel (ships un-graphed + flagged).
- **`lib/edit/post-compose.js`** — `compose_post` job (auto-chained after base image): archetype
  pick from design_prompt keywords (stat_card / quote / product_hero — v1 library condensed),
  self-contained 1080×1350 HTML composite, shared `chrome-shot.js` helper (v1's per-render
  profile-dir fix) → R2 kind='post_final'.
- **Ops:** audio library endpoints (`POST /api/admin/audio` raw-body upload + vibe tags/license
  note, `GET` list w/ ffmpeg availability); Dockerfile now installs **ffmpeg + chromium**
  (CHROME_PATH=/usr/bin/chromium); ffmpeg installed on the dev Mac via brew this session.
- **Verified:** smoke **65/65 PASS** (mock chain: auto-assembled 4 reels + composed 2 posts, reuse
  pulled 3 pool shots, cut-plan snap math, archetype routing, track scoring, **REAL ffmpeg onset
  detection: 3 synthetic bursts found at exactly 3s/6s/9s**). **`scripts/verify-edit-real.js`
  7/7** — REAL end-to-end with ffmpeg-synthesized shots + burst track: 1.7MB real reel (2 shots
  incl. reused sibling, 2 real onsets, chrome_overlay end-card) + 63KB real Chrome stat-card
  composite.

## Phase 6 — QC BUILT + VERIFIED (same session) → v0.7.0
- **Migration 006:** `qc_verdicts` (append-only training store: verdict + reason_text +
  reason_tags face_quality|caption|brand_tone|off_pillar|product|motion|audio, actor) +
  `qc_learnings_cache` (volume-cached summaries — v1's file cache moved into SQLite).
- **`lib/qc.js`** — `applyVerdict()` single entry: approve → status approved + verdict row;
  reject → verdict row + **feedback written into brief.regen_feedback** (render prompts inject it
  — v1's dropped-feedback bug stays fixed) + old artifacts soft-deleted (incl. the reel's own
  fresh shots) + re-enqueued render. **Hard cap `REGEN_CAP=3`** (operator spec): 4th reject →
  status rejected + warn log (cost guard). `phantomVerdict()` recasts a face with the feedback as
  an AVOID note — the locked appearance_prompt never mutates.
- **`lib/qc-learnings.js`** — `rollup()` (deterministic: approval rate, top tags, recent reasons),
  `summarizeLearnings()` (≤6 imperative bullets via Haiku, cached by verdict count),
  `brandLearningsBlock()` → **script-gen injects into ideation + brief prompts** and stamps
  `learnings_used` in the artifact. Reject today → next batch briefed to avoid it. Compounds.
- **`lib/coverage.js`** — deterministic report: counts vs plan (+ custom-build detection), pillar
  actual-vs-target ±1, all-6-phantoms-used, campaign-type spread, QC funnel, per-bucket ok +
  overall green.
- **Queue improvement (live-test catch):** generate-media kicks reels before phantoms finish →
  first attempt burned + 30s generic backoff. Added **`err.retryAfterSec`** override; the
  phantom-ref dependency wait retries in 5s. Pieces now reach ready in seconds, not half-minutes.
- **Console:** production.html — ✓/✗ QC buttons on ready pieces (reject prompts reason + tags),
  regen n/3 chips, Coverage panel w/ GREEN/ATTENTION badge, pillar/type/QC-funnel lines.
- **Endpoints:** POST /api/admin/piece/:id/qc · POST /api/admin/phantom/:id/qc ·
  GET /api/admin/intake/:id/coverage · GET /api/admin/tenant/:slug/learnings.
- **Verified:** smoke **77/77 PASS** (approve; reject→regen w/ new assets; cap at 3 exact;
  rollup/cache/block; scriptgen learnings pass; coverage shape). **Live HTTP:** reject → regen
  1/3 → re-ready in ~10s w/ feedback stored; learnings endpoint returns bullets + tag counts.

## Next session
1. **Phase 7 — Deploy + tracker:** Ayrshare adapters (v1 port), calendar-driven publish,
   month-end tracker → report → learnings → upgrade offers.
2. **Phase 8 — local claude_code e2e + promote-to-prod sync + journey dashboards + gallery/ZIP.**
3. Then: the post-build operator checklist (docs/PLAN.md) — Fal setup first.

## Runbook
```bash
cd ~/Downloads/000_phantom2.0/backend
npm run smoke          # $0 verification
npm start              # localhost:3020
# release (once staging exists): npm version <bump> → tag → push --follow-tags → fly deploy -a phantom2
```

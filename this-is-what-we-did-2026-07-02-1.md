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

## Next session
1. **Phase 4 — Media engine:** Fal integration real (nano-banana phantom refs + frames, seedance
   video), webhook-driven job advancement, shot library w/ cross-reel reuse, R2 ingest +
   media_assets rows, per-batch cost preflight + the billing breaker in anger.
2. Ops when ready: Fly app + R2 bucket; GOOGLE creds; STRIPE_WEBHOOK_SECRET; rotate Claude+Fal keys.
3. Later: scraper headless rung, Apify adapter, Wikipedia fallback.

## Runbook
```bash
cd ~/Downloads/000_phantom2.0/backend
npm run smoke          # $0 verification
npm start              # localhost:3020
# release (once staging exists): npm version <bump> → tag → push --follow-tags → fly deploy -a phantom2
```

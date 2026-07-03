# Phantom 2.0 — build plan + decision log

Source spec: the three BPMN sheets in `docs/bpmn/` + operator notes (2026-07-02 session).
v1 (`000_Phantom` → online-phantom.com) is the reference implementation and lesson bank;
**2.0 supersedes it** — no further v1 bug work (operator decision 2026-07-02).

## Decisions (operator-confirmed)

- **2.0 supersedes v1.** v1's open bugs (posts stuck rendering, Enhancor credits) are
  fixed *by architecture* here (jobs queue + billing breaker), not patched there.
- **Media providers:** image locked to Nano Banana, video locked to Seedance 2.0, both
  via **Fal.ai** (ids config-pinned in env, verified in Phase 4).
- **Music:** the beat-cut editor is **audio-source-agnostic**, fed by an operator-supplied
  rights-cleared library (`audio_tracks` + R2). No YouTube ripping — copyright liability
  in a commercial product, and API-published business accounts don't get trending
  commercial audio anyway (baked-in tracks get muted/removed). Operator is evaluating
  licensing options; AI-gen music is a possible later source.
- **Remotion returns** for the reel *graphics* layer (infographics, motion curves, chalk
  effects, end-card logo) + post stills — distinct from v1's removed captions layer.
- **Spend is opt-in, never default:** mock modes are the default everywhere (v1 lesson C5).
- **Queue-first:** every render/gen/scrape unit is a `jobs` row — per-kind concurrency
  caps, retries with backoff, billing circuit-breaker, restart-safe (v1 post-stampede +
  stranded-faces lesson).
- **R2-first:** artifacts land in R2 at creation; only SQLite lives on the Fly volume.
- **Fal webhooks** advance jobs (v1 lesson: browser-tab polling strands pipelines).

## Phases (each mock-verified at $0 before real spend)

- **0 · Foundation ✅ (2026-07-02)** — repo, ported v1 auth/gate/safety/storage/logs,
  fresh schema (orgs/users/events/jobs/cost_events/media_assets/audio_tracks), jobs
  worker + billing breaker, events beacon + admin summaries, LLM boundary with
  `claude_code` local mode, Fal client scaffold, console shell, smoke test.
- **1 · Agent-Scraper** — taxonomy tree from `agent-scraper.pdf` as a structured-output
  contract; escalation ladder (fetch → sitemap crawl → headless → oEmbed/public APIs);
  per-source status flags (`scraped | partial | blocked_needs_apify`) surfaced in admin;
  token budget gates (Sonnet extract / Opus synthesize / Haiku classify); vertical
  branches (apparel, music artist); tenants + intake tables; scrape artifacts → R2.
- **2 · Funnel** — value prop (3× 16:9 frames), pricing (Standard $800 one-time /
  Premium $1000 / Ultra $2000 / Overkill $4000 mo), Google OAuth, Stripe (test mode),
  admin overrides (skip OAuth + payment, full pipeline still runs), agent-email skeleton
  (stage triggers from the events stream).
- **3 · Script-gen** — plan → quantities + deployment calendar (Premium = 1 reel + 1
  post/day); 5–30 campaign ideas (product / weather / FIFA / world-event / business-event
  via web-search feed); campaign = reel+post cluster sharing one visual design; 6 phantoms
  from scraped personas (reference images for consistency); per-piece briefs.
- **4 · Media engine** — Fal integration real (nano-banana images, seedance ≤3-keyframe
  video), webhook-driven job advancement, shot library with cross-reel reuse (~40% clip
  savings), R2 ingest + `media_assets`, per-batch cost preflight.
- **5 · Edit layer** — beat-cut editor (ffmpeg low-band energy flux → cut list snapped to
  drops; ≤3 clips/reel; operator track library), Remotion graphics pass, post composer
  (v1 design-archetype library extended, Pinterest-tagged, brand-token driven).
- **6 · QC** — flag → regen (hard max 3 per piece), verdicts + reasons → `<brand_learnings>`
  into the next batch (v1 Phase 4/5 port), coverage report, calendar review UI.
- **7 · Deploy + tracker** — Ayrshare adapters (v1 port), calendar-driven publishing,
  month-end tracker → report → learnings → next-month briefs + upgrade offers.
- **8 · Local mode + sync** — `CLAUDE_MODE=claude_code` end-to-end locally, same R2 bucket
  under a `local/` namespace, one-click promote-to-prod (objects + rows), journey funnel
  dashboards, admin sandbox (arbitrary reel count × brand).

## Post-build operator checklist (once ALL phases are built — operator decision 2026-07-02)

1. **Fal.ai setup** — fund the account, then verify the pinned model ids + input field names
   against fal.ai/models docs (`FAL_IMAGE_MODEL`/`FAL_VIDEO_MODEL` env + the submit inputs in
   `lib/media/render.js`). First funded run: 1 phantom + 1 reel + 1 post before any batch.
2. **Rotate keys** — Claude + Fal keys sat in plaintext in `~/Downloads/Phantom2.0.env.rtf`.
3. **Google OAuth** — create the OAuth client (GCP console), set GOOGLE_CLIENT_ID/SECRET +
   authorized redirect `https://<domain>/auth/google/callback`.
4. **Stripe live** — webhook endpoint + STRIPE_WEBHOOK_SECRET; swap test keys for live at launch.
5. **Fly + R2 provisioning** — `fly launch` (app `phantom2`, 2 GB), volume, R2 bucket
   `phantom2-prod` + keys, secrets via `fly secrets set`.
6. **Audio library** — upload rights-cleared tracks (console → Audio panel) with vibe tags;
   licensing solution still being evaluated by operator.
7. **Remotion compositions** — the graphics pass currently ships the ffmpeg end-card backend;
   scaffold the Remotion project (compositions per `graphics_notes`: infographics, motion curves,
   chalk effects) behind `REMOTION_ENABLED=1`.
8. **Domain cutover** — point online-phantom.com at phantom2 once parity is verified.

## Ops notes

- Staging Fly app `phantom2` (2 vCPU / 2 GB — v1's stampede died on 1 GB); domain
  `online-phantom.com` cuts over from v1 at parity.
- Keys in `backend/.env` (gitignored) came from `~/Downloads/Phantom2.0.env.rtf` —
  **rotate Claude + Fal keys** before launch (sat in plaintext in Downloads).
- Versioning: semver + tag-on-main + `/version` stamp (v1 protocol carries over).

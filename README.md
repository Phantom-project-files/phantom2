# Phantom 2.0

Done-for-you AI social content SaaS — the full-BPMN rebuild of [Phantom v1](https://github.com/Phantom-project-files/online-phantom)
(live at online-phantom.com, which this repo supersedes at feature parity).

**The flow** (see `docs/bpmn/`): scrape a business → value proposition → pricing →
OAuth + Stripe → campaigns (product / weather / FIFA / world-event / business-event)
→ 6 "phantom" UGC characters → reels (Nano Banana keyframes → Seedance video →
beat-cut edit → Remotion graphics) + posts (Nano Banana + design-archetype composites)
→ human QC (max 3 regens, verdicts feed the next batch) → calendar → deploy
(Ayrshare) → month-end tracker → learnings + upgrade offers. Media via **Fal.ai**,
storage **Cloudflare R2**, DB **SQLite** on a Fly volume.

## Run locally ($0)

```bash
cd backend
cp .env.example .env        # fill ADMIN_USERNAME / ADMIN_PASSWORD at minimum
npm install
npm run smoke               # module smoke test on a scratch DB
npm start                   # http://localhost:3020 — coming-soon + lock icon → operator console
```

Default modes are free: `CLAUDE_MODE=mock`, `MOCK_MEDIA_GEN=1`, `STORAGE_BACKEND=local`.
Spending anything is an explicit opt-in:

| knob | free | real |
|---|---|---|
| `CLAUDE_MODE` | `mock` | `claude_code` (local Max subscription, $0 API) / `anthropic_api` (prod) |
| `MOCK_MEDIA_GEN` | `1` | `0` (Fal spend) |
| `STORAGE_BACKEND` | `local` | `r2` |

## Repo layout

```
backend/           Express monolith (single deployable)
  lib/             db + migrations, llm boundary, jobs queue, fal client, storage, safety
  admin/           operator auth routes
  middleware/      requireAdmin
  public/          coming-soon, operator console
  scripts/smoke.js $0 verification
docs/bpmn/         the three BPMN spec sheets (master flow · scraper taxonomy · script-gen)
docs/PLAN.md       phased build plan + decision log
```

## Build status

Phase 0 (foundation) ✅ — operator auth + coming-soon gate, SQLite jobs queue with
per-kind concurrency caps + billing circuit-breaker, user-journey events stream,
LLM boundary (mock | claude_code | anthropic_api with Opus/Sonnet/Haiku task routing),
R2/local storage, Fal client scaffold, operator console shell.

Phase 1 (Agent-Scraper) ✅ — taxonomy contract (`lib/scrape/taxonomy.js`: gated LLM
sections, token-budget capped), fetch ladder + blocked-detection, per-source honest
status flags (`blocked_needs_apify` tells the operator which Apify actor to buy),
social probes, vertical branches (apparel / music_artist), console scraper sandbox.
Verified offline (fixture) and against the real internet (allbirds.com: IG public
metadata scraped, TikTok correctly flagged, Shopify detected).

Phase 2 (Funnel) ✅ — 3-frame value proposition auto-built after every scrape, 4
pricing tiers (BPMN numbers), Google OAuth (OIDC, claims intake→org→tenant), Stripe
checkout + signature-verified webhook (test-mode verified live), admin override
(skip OAuth+payment, full pipeline unlock), agent-email skeleton (mock/Resend, stage
triggers off the events stream), full funnel pages with journey tracking.

Phase 3 (Script-gen) ✅ — payment auto-triggers production state: 6 phantoms cast
from scraped personas (locked appearance prompts), 5–30 campaigns ideated against a
grounded moments feed (FIFA/holidays/season/drops — never invented), deterministic
allocation (pillar split, phantom round-robin, Premium = exactly 1 reel + 1 post/day
calendar), per-piece production briefs (frame prompts ≤3, video/audio/graphics
instructions). Operator sandbox: custom reel/post counts per brand + regenerate.

Phase 4 (Media engine) ✅ — Nano Banana phantom faces + keyframes, Seedance
image→video shots, order-based shot reuse (~33% fewer video gens), webhook-
accelerated single-path polling (no double-ingest), R2 ingest + media_assets,
cost preflight (console shows the $ estimate before the operator clicks
Generate — media never auto-fires), billing breaker wired to Fal errors.

Phase 5 (Edit layer) ✅ — beat-cut assembler (ffmpeg energy-flux onset detection,
cuts snapped to drops, ≤3 shots/reel with campaign-pool reuse, operator audio
library — silent+flagged when empty), chrome_overlay brand end-card (drawtext is
build-dependent; overlay isn't), post composer (archetype-routed 1080×1350
composites via headless Chrome). Real-path verified with synthesized media
(`scripts/verify-edit-real.js`). Docker image: +ffmpeg +chromium.

Phase 6 (QC) ✅ — flag → regenerate with the reason injected into the render
prompt (hard cap: 3 regens/piece), append-only verdict store rolls into
`<brand_learnings>` briefing the next batch (Haiku-summarized, volume-cached),
deterministic coverage report (counts/pillars/phantom-usage/QC funnel → green),
console QC buttons + coverage badge. Dependency waits retry in 5s not 30s.

Phase 7 (Deploy + tracker) ✅ — Ayrshare per-tenant profiles + hosted social
linking, calendar-driven publishing (approved pieces only — QC is the gate;
Standard tier routes to gallery/ZIP instead), metrics snapshots with implicit
scheduled→published sync, month-end report (winners, narrative, performance
rules) feeding `<brand_learnings>` alongside QC — plus the upgrade-offer email
when a brand outgrows its plan.

Next: Phase 8 (final) — local claude_code e2e, promote-to-prod, journey
dashboard, gallery/ZIP. Post-build operator checklist: `docs/PLAN.md`.

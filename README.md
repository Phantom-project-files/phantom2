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

Next: Phase 3 — Script-gen (calendar, campaigns, 6 phantoms, briefs).
Full plan: `docs/PLAN.md`.

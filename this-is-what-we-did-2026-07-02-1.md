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

## Next session / remaining Phase-0-adjacent
1. **Phase 1 — Agent-Scraper** (taxonomy contract from `docs/bpmn/agent-scraper.pdf`, escalation
   ladder, `needs_apify` per-source flags, token budget gates, tenants+intake migration).
2. Optional ops: create the `phantom2` Fly app + R2 bucket (`phantom2-prod`) when we want staging.
3. Rotate Claude + Fal keys (they were in `Phantom2.0.env.rtf` in Downloads).

## Runbook
```bash
cd ~/Downloads/000_phantom2.0/backend
npm run smoke          # $0 verification
npm start              # localhost:3020
# release (once staging exists): npm version <bump> → tag → push --follow-tags → fly deploy -a phantom2
```

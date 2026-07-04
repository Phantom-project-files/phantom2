# this-is-what-we-did — 2026-07-04 — session 2

(New conversation/session — continues from session 1's close at commit 863022c.
Session 1's log: `this-is-what-we-did-2026-07-04-1.md`.)

## Context at open
- Working tree was clean at `863022c` (session 1's close commit); `:3020` was NOT running
  (checked — session 1's log said it was, but that was stale by the time this session opened).
- Blue Bottle Coffee intake `E-U9Vg7dAkR_`: per session 1's log, 2 second-take pieces `ready`
  awaiting an operator QC verdict — not re-verified this session (untouched by this session's
  work).
- **Fal balance flagged as likely near empty** ($22.40 spent all-time vs $18.48 added) —
  still unresolved, still worth checking before any real-money run.
- Parked from session 1: Meta IG-audio creds, Stripe live, Fly deploy, font self-hosting,
  licensed music library — untouched this session.

## Prompt 1 — Seedance-2.0-AI-UGC repo review → media-gen prompt upgrades
User asked to read `github.com/sirioberati/Seedance-2.0-AI-UGC` and use it to update how
Phantom's media gen approaches content generation, explicitly making sure captions/graphics
stay OUT of the generation prompt (Remotion/chrome_overlay already owns that layer).

### What the reference repo actually is
Cloned to scratchpad and read in full. It's a Claude-Code-driven UGC ad tool wrapping
**Enhancor's** Seedance-2 API (not raw fal.ai) — a fixed 4-format × 2-angle test matrix
(Podcast/UGC/Lifestyle/Greenscreen × Problem-Solution/Social-Proof/Authority/etc.), per-image
"ad_notes" (vision-analyzed product/subject/mood context folded into every prompt), and
strict human-approval-before-spend gates. **Grepped it for caption/overlay/subtitle/CTA-card
behavior before touching anything — found none**; the "remove captions/graphics" instruction
was a guardrail to apply while porting technique, not a fix for something the reference repo
does. Its provider (Enhancor) is v1's old stack — NOT re-adopted; 2.0 already made the
Enhancor→Fal call on purpose (see [[phantom-project]] 2026-07-02). Only the prompting
*technique* was ported, never the API.

### Built
1. **Vision-derived product ad_notes** (`lib/scrape/runner.js`) — new `analyzeProductImage()`
   wires up `llm.vision()` (`lib/llm.js` — existed already, had zero callers anywhere in the
   codebase until now). Best-effort: only runs under `CLAUDE_MODE=anthropic_api` (vision has
   no claude_code CLI stdin path — silently skipped otherwise, same as mock); any failure just
   returns `null`. Result stored as `meta.ad_notes` on the product `media_asset`.
2. **render.js threads ad_notes into the actual Fal prompt** — `productRefUrls()` now returns
   `{url, adNotes}` pairs instead of bare URLs; new `productReferenceClause()` folds the
   vision notes into the "reference image(s) attached" sentence when present, and degrades
   to the old generic sentence when not (mock mode, non-API CLAUDE_MODE, or pre-existing
   product assets scraped before this shipped). This directly targets the exact gap the first
   live Blue Bottle run hit (product fidelity).
3. **No-onscreen-text guardrail** — new `NO_ONSCREEN_TEXT` const in render.js, appended to
   every post/reel-keyframe/Seedance-video prompt; scriptgen's brief system prompt now states
   the same rule explicitly and clarifies `graphics_notes` is for the SEPARATE post-production
   stage (lib/edit/graphics.js) only, never the generation prompt. Ties directly to the
   Prompt-5-session-1 QC-reject forensics ("end title brand identity") — the model had been
   rendering its own end-card, fighting the real chrome_overlay/remotion one.
4. **Reel shot-style archetypes** — `SHOT_STYLES` in render.js (`ugc_handheld` /
   `cinematic_lifestyle` / `bold_studio`), same fixed-vocabulary spirit as
   `post-compose.js`'s `ARCHETYPES`. scriptgen's brief LLM now picks one per reel into a new
   `brief.shot_style` key (additive JSON field — no migration needed, `brief` is schemaless);
   render.js's `shotStyleClause()` folds the matching camera-direction line into both the
   keyframe image prompt and the Seedance video prompt. `mockBriefs()` cycles all three so
   $0 mock runs exercise every style.
5. **Proven persuasion-angle vocabulary** — campaign ideation prompt now names 7 proven ad
   angles (problem-solution, social proof, authority/expert, before-after transformation,
   pattern-interrupt hook, comparison, day-in-the-life routine) and asks each campaign to
   rotate through them, naming the chosen angle at the start of `concept`. Prompt text only,
   no schema change.

### Verification
- `node --check` on all 3 edited files (`lib/scrape/runner.js`, `lib/media/render.js`,
  `lib/scriptgen/index.js`).
- Checked `lib/safety.js`'s `validateOutput()` first — confirms extra JSON keys (like the new
  `shot_style`) never fail schema validation, only missing *required* keys do.
- `node scripts/smoke.js` → **ALL PASS** (all ~90 checks, including "reel brief contract" —
  unaffected by the additive `shot_style` field).
- `scripts/verify-edit-real.js` not re-run — it doesn't import any of the 3 changed files
  (confirmed via grep), so it isn't exercising this change.

### Not done / consciously scoped out
- No 2-person "podcast" dialogue format and no lip-sync/spoken-dialogue timeline — that's a
  different product; Phantom is silent b-roll + operator-attached trending audio by design
  (the 2026-07-04 pivot), so the reference repo's word-count/timestamp dialogue formula
  doesn't apply here.
- Did not touch `lib/edit/graphics.js`, `assemble.js`, or `remotion.js` — the graphics/caption
  separation was already correctly architected there ([[phantom-captions-removed]]); this
  session only closed the loop on the *generation* side so the two layers stop fighting.
- No console/gallery UI changes — scoped to the generation pipeline only (scrape → scriptgen
  → render).
- Did not wire vision-derived ad_notes into `scrape.json`'s artifact for scriptgen's brief
  text itself (only into the render-time Fal prompt via media_assets.meta) — render.js was
  the higher-leverage fix since that's where the actual image/video prompt is built.

### State at close
- No server running. Working tree has 3 backend files changed
  (`lib/scrape/runner.js`, `lib/media/render.js`, `lib/scriptgen/index.js`) + this log —
  about to commit + push per [[session-log-protocol]].
- Fal balance still unverified/likely low (carried over from session 1) — check before the
  next real-money run, and before relying on `analyzeProductImage()` vision calls in
  production (needs `CLAUDE_MODE=anthropic_api` to actually fire — current `.env` has
  `CLAUDE_MODE=claude_code`, under which the new vision step silently no-ops).
- Blue Bottle intake `E-U9Vg7dAkR_` QC verdict still outstanding (unchanged, not touched).

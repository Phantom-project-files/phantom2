# this-is-what-we-did — 2026-07-04 — session 1

(Continuation of the 2026-07-03 session — same conversation, date rolled over.
Yesterday closed at ba73f5b: console Audio panel + real-audio demo beds, smoke green.)

## Context at open
- Product state: Standard-only tiers, trending-audio delivery model (silent download +
  preview-with-audio + day-folder ZIP), IG Audio API adapter in mock mode awaiting Meta creds.
- Customer funnel UI was bare-bones: 2.0's index.html was a plain two-field form, no landing.
- v1 (`~/Downloads/000_Phantom`) has the polished funnel UI the user likes.

## This session
### v1-style preview funnel ported into 2.0 (landing → wizard → proposal → plans)
User: "i liked phantom v1 UI can you add a preview funnel that takes me to a landing page
(get started) then business name so on and so forth. and make sure to run ui check before
confirming its working."

What was built (v1 pages ported, rewired to 2.0's API):
1. **`public/app/assets/phantom.js` (new)** — trimmed port of v1's helper lib: DOM/fetch
   helpers, inline-SVG icon set, toast, nav state, version stamp. v1's session plumbing
   (`/api/session`), help modal and dev pills deliberately NOT ported (2.0 uses /api/me +
   Google OAuth; no dev-bypass surface).
2. **`public/app/assets/landing/reel_NN.mp4` × 16 (new)** — the v1 landing's reel wall,
   transcoded from v1 renders (720p→8s, muted, crf30): 26MB → 3.1MB total.
3. **`public/app/index.html` (replaced)** — full v1 landing port: animated 3D reel cylinder
   (two counter-scrolling chess-pattern rows), liquid-glass hero card, ghost mark with
   cursor-tracking eyes, PHANTOM wordmark, 30·30·30 tricolon (still true: Standard = 30 reels
   · 30 posts · 30 days), halo "Get started" CTA → intake.html. The old two-field form moved
   into the wizard.
4. **`public/app/intake.html` (new)** — v1's 3-step wizard: business name → website →
   research loader. Step 2 POSTs `/api/intake` (2.0's single-call create; v1's
   bootstrap/site split and socials mode dropped — 2.0 API is website-only), step 3 polls
   `/api/intake/:id/status` with cycling status copy until `value_prop`, then hands off to
   proposal.html (which renders instantly). Failure → inline error + "try a different
   website"; 3-min cap → soft-forward to proposal (it keeps polling). localStorage prefill.
5. **`server.js`** — `/` now 302s to `/app/index.html` instead of sendFile(coming-soon).
   Gate unchanged: COMING_SOON=1 still swaps in coming-soon.html for non-operators before
   this route fires; prod stays gated via fly.toml `[env] COMING_SOON="1"`.
6. **`.env` local** — `COMING_SOON=0` (with comment): localhost preview needs no operator
   login. Prod unaffected (fly.toml pins 1).
7. **`proposal.html`** — failed-scrape "Try another website" now returns to intake.html
   (was index.html, which no longer has a form).

### UI check (before confirming — as asked)
Isolated mock instance on :3021 (scratch DB + media root, CLAUDE_MODE=mock, $0) driven with
Chrome DevTools MCP, viewport 1440×900:
- Landing: renders pixel-faithful to v1; **32/32 reel-wall videos playing**, console clean.
- Get started → wizard step 1 → "Acme Swim" → step 2 (dots advance) → "example.com" →
  Begin → intake created (real scrape of example.com + mock LLM) → **proposal renders
  personalized "PROPOSAL · ACME SWIM"** with 3 frames → See plans →
  **plans show Standard active, Premium/Ultra/Overkill "Coming soon"** → Choose Standard →
  signup.html?intake=…&plan=standard ("Create your account", Google button).
- Step-3 loader screen verified visually (mock research outruns the 2.5s poll, so it was
  forced visible for the screenshot; on :3020 real research will show it naturally).
- Mobile 390×844: glass card, tricolon and CTA all scale correctly.
- Real :3020 instance: `/` redirects to the landing, renders clean console.
- Console-error sweep on every funnel page: zero errors from our pages (only the expected
  401 session-probe on signup.html for signed-out visitors — pre-existing behavior).
- `scripts/smoke.js`: **ALL PASS** after the server.js route change.

### Operator notes
- **Open http://localhost:3020 → you land on the funnel.** No login needed locally now
  (COMING_SOON=0 in local .env only).
- Funnel APIs are public under COMING_SOON=0 — on localhost that's just you. At launch the
  fly.toml gate keeps prod on coming-soon until you flip it.
- A real funnel run on :3020 spends real LLM tokens at the proposal step (CLAUDE_MODE is
  live there); the UI check burned $0 by using the mock instance.
- Landing reel wall uses transcoded v1 Fallacié renders as decorative backdrop — swap
  `public/app/assets/landing/` when 2.0 has its own showcase set.

## Prompt 2 — operator unblock + sandbox + full UI redo (in progress)
User feedback: can't reach generation (Google/Stripe wall), console needs a sandbox
generation tab (scrape → custom reel/post counts → staged generate), UI unappealing →
redo in the v1 design language. Subagents on opus/sonnet to save credits; prepare for
credit cutoff mid-run.

### Done so far (committed here)
- `assets/phantom.js`: `mountAdminDashboard` pill (v1 port) — admin session ⇒ every
  funnel page shows a top-center "Operator console" pill (probes /admin/auth/me).
- `signup.html`: "Continue as operator →" appears when /api/config says is_admin —
  skips Google (admin cookie already satisfies checkout's requireUserOrAdmin).
- `checkout.html`: rebuilt — operators get a choice card (Override→paid via
  POST /api/admin/intake/:id/override {plan}, or proceed to real Stripe); customers
  get the old auto-redirect. Override → checkout-success → production unlocked.
- Server already had EVERYTHING for the sandbox: POST /api/admin/intake (create),
  /override, /scriptgen {reels,posts,regenerate}, /generate-media {phantoms,reels,posts},
  /media-estimate, /production, /coverage, GET /api/admin/intakes.

### NEXT (if this session dies, resume exactly here)
1. Three agents redesign UI (specs in prompt): opus → admin.html console redesign +
   Sandbox pipeline runner panel; sonnet → funnel pages (signup/checkout/success/
   plans/proposal); sonnet → production.html + gallery.html. Constraints: preserve all
   ids/endpoints/flows, no server/css/phantom.js/track.js/index/intake edits,
   node --check inline JS, curl :3020 for 200.
2. Then browser UI check on isolated :3021 mock (throwaway admin creds env-injected,
   curl login → cookie into chrome-devtools; NEVER type passwords) — full operator
   funnel: landing → wizard → proposal → plans → signup operator-skip → checkout
   override → success → production generate (mock, $0) → gallery. Sandbox run in
   console too. Mobile spot-check. Console-error sweep.
3. smoke.js, commit, update memory phantom_project.md.

### Agents delivered (opus console + sonnet pages) — all verified in browser
- **admin.html (opus)** — full console redesign: glass topbar (brand · "User landing ↗" ·
  Sign out), section tabs (Sandbox · Pipeline · Audio · Analytics · System), and the NEW
  **Sandbox pipeline runner**: scrape form → intake picker → stage strip (scraped/proposal/
  paid/scripted/media/edited) → Override→paid (plan select) → Script-gen with CUSTOM
  reel/post counts (+regenerate) → staged Generate media (Phantoms / N reels / N posts /
  everything) with cost preview + mock badge → live progress (pieces/assets/queue) →
  open-links (production/gallery/proposal/plans/scrape.json). All pre-existing panels
  (audio/jobs/spend/funnel/journey/system) preserved and live.
- **Funnel pages (sonnet)** — plans (AVAILABLE NOW vs locked COMING SOON cards), proposal
  (glass frames, staggered reveal, "PROPOSAL FOR <brand>" label), signup (glass auth card,
  operator divider), checkout (Operator checkout card), checkout-success (teal check badge,
  FIXED stale copy, "Open your gallery →" CTA). All ids/flows/track events preserved.
- **production.html + gallery.html (sonnet)** — production room (hero chips, phantom cards,
  campaigns, coverage bars, Su–Sa month-grid calendar, deploy, dense pieces table w/ QC
  circles), gallery (day-group headers, 9:16/4:5 cards, audio-note SVG instead of emoji).

### Fixes found in browser verification (mine, after agents)
- production.html: report probe fetched `/api/admin/tenant//report/latest` (404 noise) when
  no social connection — now skipped unless connected.
- admin.html: `.runner-empty { display:flex }` defeated the `hidden` attribute → global
  `[hidden]{display:none!important}`; placeholder now hides when the runner loads.

### Browser UI check round 2 (isolated :3021, throwaway admin creds, $0)
- Console: login via page-context fetch (never typed a password; document.cookie writes are
  blocked in the automation browser — server-set cookie via /admin/auth/login fetch works).
- **Sandbox driven end-to-end through the UI**: scraped "Acme Swim"/example.com → chips lit →
  Mark paid (admin_override, standard; auto script-gen 30/30) → Script-gen custom **2 reels
  + 3 posts** w/ regenerate (pieces: 60 → 5 exactly) → staged generate: Phantoms (6/6 ready)
  → Reels (2 ready + assets) → Posts (3 ready) → 11 assets, all 5 pieces ready → QC-approved
  → gallery shows day-grouped cards. Estimate showed $7.26-real / mock-$0 guardrail.
- **Operator funnel walk**: landing (Operator-console pill) → wizard ("Coastal Coffee") →
  restyled proposal → plans (admin detected → straight to checkout) → Operator checkout →
  Override → success page → gallery CTA. Zero console errors on every page.
- Mobile 390×844: plans/landing stack correctly.
- Real :3020: all 10 app pages 200, admin.html correctly 302-gated. smoke ALL PASS.

### Notes
- Google Fonts @import lives in phantom.css line 8 (since v1; v1 prod runs with it) — NOT
  introduced by the redesign. Self-hosting the three families is a launch-hardening item.
- The sandbox "Mark paid" auto-runs script-gen at plan volume; use Script-gen w/ regenerate
  for custom counts after (or script-gen first, but paying re-enqueues once — last run wins).

## Prompt 3 — first REAL generation through the new sandbox (Blue Bottle Coffee)
Operator logged in and ran it themselves on :3020: scrape (3rd attempt clean; first two
failed — site blocked scraper), Override→paid (standard), staged generate **1 reel + 1 post**.
Verified server-side while in flight, then to completion:
- 6 phantoms rendered (real Fal), post 289 ready, reel 286: 2 Seedance shots → beat-cut
  assemble vs track 9 "Neon Nights" (14 onsets, cuts snapped, chrome_overlay).
- **Dual output confirmed by ffprobe**: master zGU5…mp4 audio=NONE 11.5s (the download);
  preview SlBl…mp4 audio=AAC 11.5s (gallery playback). meta audio_mode=silent_delivery,
  instruction "Neon Nights by Phantom Beds, cut @ 5.5s".
- Gallery payload: both pieces, reel plays preview asset 374 w/ attach-instruction.
- **Real spend: $4.99** (6 faces $0.90 · 2 keyframes $0.30 · 2 video shots $3.64 ·
  1 post image $0.15). Monitor watched the in-flight Fal polls (attempt 4/12, healthy).
- The intake's other 58 pieces stay briefed ($0) — staged generation worked exactly as
  designed on real money.

## Prompt 4 — why no Blue Bottle products? → real-Claude briefs + product-reference plumbing
Diagnosis of the first real run: (1) CLAUDE_MODE was still `mock` → canned generic briefs
("phantom holds product", caption "#brand"); (2) the model call attached ONLY the phantom
face ref — no product images existed (scrape harvested 0 URLs; bluebottlecoffee.com is
srcset-lazy-loaded) and render.js had no plumbing for them anyway.

### Built
- `.env` CLAUDE_MODE=mock → **claude_code** (local CLI, Max plan, $0 — verify-claude-code
  14.3s ✓).
- `lib/scrape/fetcher.js`: srcset/data-srcset parsing (largest candidate) merged into the
  image harvest — the Blue Bottle lesson.
- `lib/scrape/runner.js`: `harvestProductImages` — downloads up to SCRAPE_PRODUCT_IMAGES=3
  product-page/og images (type+size guards, product-page priority, logo/icon filtered) into
  storage as kind='product' media_assets (ref=intake); offline/smoke → no-op; flags when none.
- `lib/scrape/taxonomy.js`: scrape JSON now carries brand_assets.product_images
  [{asset_id, source_url, page_kind, bytes}].
- `lib/media/render.js`: `productRefUrls` (PRODUCT_REF_IMAGES=2 default) — post + reel
  keyframe calls now send image_urls = [face, product×2] (cap 3) to nano-banana /edit with a
  reproduce-the-real-product instruction; `media.reel_kicked` log now records ref counts.
- Ordering discovery: script-gen has an existing-production guard → running custom-count
  scriptgen BEFORE override means the override's auto script-gen skips (no wasted full-volume
  pass). Sandbox habit: scrape → scriptgen {counts} → override → generate.

### Re-run (intake E-U9Vg7dAkR_, tenant blue-bottle-coffee-txtp) — all verified
- Scrape (claude_code): **3 product photos harvested** (Cloudinary, 239-445KB); real sections
  ("Golden Hour" summer seasonal w/ tasting notes, "Hayes Valley Espresso" best seller).
- Script-gen {1,1}: 3 LLM calls, $0 — REAL briefs: reel = Elena Vega, 6pm golden light,
  Golden Hour over ice, tasting-note overlays; post = Marcus Bell holding the Golden Hour bag.
  Auto-run after override: "skipped: existing production" ✓.
- Media: kick log **"refs: 3 (2 product)"** — Fal calls carried face + 2 real product photos.
  3 shots + post; **spend $6.96 = estimate to the cent**. Master audio=none, preview=AAC.

## Prompt 5 — gallery ⇄ console bridge + operator QC in the gallery
Complaints: gallery unreachable from console surfaces; no QC on the video/post where you
actually watch them; QC must influence future generations.

### Built
- **gallery.html**: admin session ⇒ every card gets an OPERATOR QC row — approve (✓) /
  reject (✗ w/ inline reason field, Enter submits, no blocking dialogs) → same
  POST /api/admin/piece/:id/qc as the production room; pill + message update in place.
  Header gains a "Production room" link (admin only). Customers see none of it.
- **production.html**: header gains a "Gallery" link (next to Console). Sandbox runner
  already had per-intake Gallery links.
- Live-verified the click path on the superseded first-run post: pill flipped to
  approved, verdict recorded.

### How QC takes effect (wiring verified in code, now ACTIVE because claude_code is on)
1. Reject w/ reason → immediate retake: reason lands in brief.regen_feedback, render
   prompts carry "OPERATOR FEEDBACK (must address)", artifacts cleared, re-render
   auto-queued (REGEN_CAP 3; 4th reject → status rejected). NOTE: each reel retake ≈
   real Fal spend; posts ≈ $0.15.
2. Verdict reasons → qc_verdicts → qc-learnings rollup → ≤6 avoid/prefer bullets
   (Haiku via CLI, $0, cached by verdict count) → brandLearningsBlock injected into
   script-gen ideation + brief prompts (scriptgen/index.js:129,164,207) for every FUTURE
   generation of that tenant. Confirmed empty-state renders cleanly for fresh tenants.
3. Approve → deployable (deploy gate is approved-only) + approval-rate signal.
   IMPORTANT NUANCE: this loop existed since Phase 6 but was inert under CLAUDE_MODE=mock
   (canned LLM ignored the injected learnings). With claude_code it's live for real.

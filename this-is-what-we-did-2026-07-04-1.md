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

# this-is-what-we-did — 2026-08-08 — session 1

(First session back after a ~35-day gap; last activity was 2026-07-04, HEAD `415398c`.)

## TL;DR / state
- **Where the project stands:** build complete + proven (Blue Bottle live run, QC loop,
  Standard-only pivot, silent+instructions delivery). Remaining to launch = ops checklist
  items 5 (Fly+R2 deploy), 4 (Stripe live), 3-deploy-step (prod OAuth URI), 6 (audio
  licensing decision), 8 (domain cutover). Fal balance likely near empty. Blue Bottle
  intake `E-U9Vg7dAkR_` still has 2 second-take pieces awaiting QC.
- **Uncommitted work from 2026-07-04 discovered on this machine only** (never pushed):
  `docs/linkedin-strategy.md` (15-post/30-day GTM plan), `promo/` (banner, PFP, 5 promo
  squares), `backend/scripts/gen-promo.mjs`. Still uncommitted — flagged to operator.
- **Operator named the real blocker** (why work stopped): no satisfying way to give client
  reels standout audio / viral IG sounds. Seedance audio is unusable; silent delivery +
  attach-natively instructions feels weak. → This session = deep research for a solution.

## Prompt 1 — status review
Read memory + repo: git log (HEAD `415398c`, 2026-07-04), latest session log
(`this-is-what-we-did-2026-07-04-2.md`), `docs/PLAN.md` checklist. Reported state above.

## Prompt 2-3 — agent-reach skill install
- Installed the `agent-reach` skill (panniantong/agent-reach, 12.3K installs, repo 69k★)
  via `npx skills add` → `~/.claude/skills/agent-reach` (symlink). Skill is registered.
- **The underlying `agent-reach` CLI is NOT installed yet** (auto-mode classifier blocks
  agent-initiated install of third-party code; pipx also missing). Operator has the exact
  `!`-prefix commands to finish: `brew install pipx && pipx install <repo zip>` then
  `agent-reach install --env=auto && agent-reach doctor`.
- Zero-config channels usable meanwhile: gh, yt-dlp, curl/Jina. Login platforms (IG,
  Twitter, Reddit, LinkedIn…) dead until the CLI + opencli exist.

## Prompt 4 — THE AUDIO PROBLEM (this session's main thread)
Operator: "biggest reason I stopped — no way to add Instagram audios / use a viral sound
and replicate it; Seedance produces crappy sounds. Research and give me up to 10 solutions,
fewer + more effective preferred."

### Context re-established before research
- `lib/edit/trending.js` — IG Audio API adapter ALREADY WIRED (GET /ig_audio, trending by
  default, `is_ads_eligible` flag; mock mode until creds). Runbook
  `docs/runbooks/instagram-audio-setup.md` = exact Meta app + System-User-token steps
  (~30-60 min operator clicking, no App Review needed for single-account trending fetch).
- `docs/research/audio-and-deployment-2026-07-03.md` — July findings: trending consumer
  audio is PERSONAL-USE-ONLY (illegal for business accounts, the emotional core of the
  stall); business-safe targets = ads-eligible IG subset, Meta Sound Collection (~14k free
  commercial-cleared), TikTok CML; Epidemic Sound Partner API = top licensed pick;
  Lickd/Mubert-sublicense/Suno flagged risky or dead.
- Gap the July research never explored: **trend-REPLICATION** — analyze the viral sound
  (beat/BPM/energy — detectCuts already exists) → generate an original trend-alike via AI
  music APIs (ElevenLabs Music etc.) → bake legally. Also unexplored: voiceover-led audio.

### Research launched (in progress at this log update)
Deep-research workflow `wf_7d4fcb7f-a91` (background): 6 questions — (1) re-verify July
facts freshness (ig_audio, Sound Collection license scope for SaaS→client baking, Epidemic
Partner API accessibility, Soundstripe), (2) AI-music trend-replication lane (ElevenLabs/
Suno/Udio/Mubert/Stable Audio/Beatoven/Soundraw/Loudly — rights, API, cost, soundalike
legal line), (3) what IG business accounts can attach natively Aug-2026, (4) confirm/kill
"no API attaches IG library music", (5) competitor precedent (Arcads, Creatify, Predis…),
(6) VO-led vs music-led performance evidence. Output feeds a ranked ≤10-solution memo
with a recommended 2–3-solution stack mapped to existing pipeline pieces.

## How to resume if disconnected
- Research results: workflow run `wf_7d4fcb7f-a91`; journal at
  `~/.claude/projects/-Users-vaibhavmathur/2bb6ae66-f0ba-40d9-be06-4281c524dfb2/subagents/workflows/wf_7d4fcb7f-a91/journal.jsonl`.
  If lost, re-run: the brief is reproducible from this log's Prompt-4 section.
- Then: synthesize memo → operator picks the audio stack → that unblocks checklist item 6
  → then deploy (item 5) → Stripe live (4) → domain cutover (8).

## Open threads
- [ ] Audio-solution memo (research running)
- [ ] Commit or discard `promo/` + `docs/linkedin-strategy.md` + `gen-promo.mjs` (operator call)
- [ ] Finish agent-reach CLI install (operator `!` commands)
- [ ] Fal balance top-up before next real run
- [ ] Blue Bottle QC verdict on 2 second-take pieces
- [ ] Deploy checklist 5 → 4 → 3-deploy → 8

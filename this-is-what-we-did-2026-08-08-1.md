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

### Research DONE → memo committed: `docs/research/audio-solutions-2026-08-08.md`
Workflow `wf_7d4fcb7f-a91`: 106 agents, 24 sources, 116 claims → 25 verified by 3-vote
panels (19 confirmed / 6 refuted / 0 unverified). All Meta pages live-verified 2026-08-08.

**THE HEADLINE: the stall's premise is dead.** Since ~2026-05-18 Meta's Content
Publishing API attaches IG-library audio to Reels at publish time via an
`audio_configuration={audio_id,audio_volume,video_volume}` object on the REELS container —
`audio_id` comes from the exact `GET /ig_audio` endpoint `trending.js` already wired.
Metricool/bundle.social/Enji already ship it. July research missed it (feature lives on a
separate docs page; main publishing guide still silent). Constraints: FB-Login-connected
business/creator accounts, REELS only, third-party-authorized subset, no API preview.
Own-account publish works in Dev mode (no App Review); client accounts need App Review or
a reviewed intermediary (bundle.social — which also does TikTok CML `song_clip_id`).

Other verified: IG trending library still personal-use-only (instruction cards for
consumer sounds = killed); Meta Sound Collection commercial-cleared but platform-locked +
non-sublicensable (never bake into ZIPs; client-attach shapes only); **ElevenLabs Eleven
Music API = the clean AI lane** (GA, self-serve, API on all paid tiers, Scale <10-employee
eligibility, ~$0.30–0.40/gen-minute → 5–20¢/reel, licensed training Merlin/Kobalt/etc.;
bespoke-per-reel permitted, cross-client catalog PROHIBITED, no artist names in prompts,
sector exclusions at intake); Suno lost GEMA 2026-07-31 + UMG/Sony ongoing, Udio partial
→ both killed; soundalike doctrine = match vibe/BPM/energy, never melody/hook/voice;
Epidemic Partner API mechanics refuted both directions → sales email, not web research.

**6 ranked solutions in the memo; recommended stack:** S2 ElevenLabs bespoke baked audio
(build NOW — un-silences ZIP delivery), S1 native-attach test via the 1-hr Meta-app
runbook (`instagram-audio-setup.md` → `verify-trending-live.js` → try
`audio_configuration` on Phantom's own IG), S5 VO-hook A/B on next real batch. Plus 3
async emails (ElevenLabs written confirmation; Epidemic + Soundstripe partner terms).

## How to resume if disconnected
- Memo: `docs/research/audio-solutions-2026-08-08.md` (committed). Raw claim evidence:
  workflow `wf_7d4fcb7f-a91` journal under
  `~/.claude/projects/-Users-vaibhavmathur/2bb6ae66-f0ba-40d9-be06-4281c524dfb2/subagents/workflows/`.
- Next: operator picks the stack → build S2 (`lib/edit/` ElevenLabs provider,
  source='ai_gen') + run the S1 runbook → that closes checklist item 6 → then deploy
  (item 5) → Stripe live (4) → domain cutover (8).

## Open threads
- [x] Audio-solution memo — DONE, committed
- [ ] Operator decision: adopt S2+S1(+S5) stack; send the 3 emails
- [ ] S1 empirical test: is_ads_eligible subset size; SC tracks addressable via API?
- [ ] Commit or discard `promo/` + `docs/linkedin-strategy.md` + `gen-promo.mjs` (operator call)
- [ ] Finish agent-reach CLI install (operator `!` commands)
- [ ] Fal balance top-up before next real run
- [ ] Blue Bottle QC verdict on 2 second-take pieces
- [ ] Deploy checklist 5 → 4 → 3-deploy → 8

## Prompt 5 — S1 deep-dive (explanation only, no code)
Explained S1 in full: stand-out mechanism (♪ chip + audio-page aggregation vs "Original
audio"), the 3-call publish flow w/ audio_configuration, legal inversion vs the killed
instruction card (Phantom never touches music bytes; is_ads_eligible filter), the
already-built inventory (trending.js/runbook/beat-cut/preview-mux/Phase-7 deploy = 90%),
missing pieces (audio_id persistence, sync-time snippet fetch, audio_configuration on
publish, direct Meta publish module — Ayrshare audio-attach unverified), Route A (own app,
dev-mode test now, App Review for clients) vs Route B (bundle.social, reviewed, also does
TikTok CML), the 4-question afternoon test (subset size, start offset, attach fidelity,
SC reachability), and the product implication: S1 un-shelves auto-deploy; S2 covers ZIP
clients — two halves of one delivery story.

## Prompt 6-7 — THE PIVOT → local-phantom built + launched
Operator: 90%-built app doesn't matter without sales history. New plan: prove demand with
a real **Fallacie** campaign (friend's brand) tracked via his Shopify, using stranded
**Enhancor credits** (Fal is empty; Enhancor was v1's provider — keys pending from
operator). Vehicle: **local-phantom**, a local ComfyUI-style node-graph dashboard at
`~/Downloads/local-phantom` (own git repo + session log — SEE THAT LOG for full detail).
Built + verified this session: 4-agent research (Enhancor API spec mined from v1;
2.0 beat-cut/llm/mock ports; React Flow v12 + ComfyUI engine patterns; yt-dlp/vision/
Shopify) → Express+SQLite server w/ topo-sort engine + signature caching + SSE →
10 nodes (reel import, Claude-VISION reel analyze, prompt, Claude write, Nano/Seedance
via real Enhancor client in $0 mock mode, IG trending audio, ffmpeg beat-cut, output) →
React Flow dashboard (Phantom brand) → seeded real Fallacié assets + demo graph →
**full pipeline ran green end-to-end twice** (12.00s 1080×1920 final reel, 6 beat-snapped
segments, second run fully cached). Server left running on http://localhost:3030.
2.0 status: unchanged, still the reference codebase; audio memo (S1/S2) still the plan
when Phantom-proper resumes.

## Prompt 8 — local-phantom round 2 (see its repo log for detail)
Enhancor key received → LIVE-verified on credits (Nano 44.3cr/28s photoreal; Seedance
348.8cr/4s ≈ 87cr/sec — campaign budget number). 3 more research agents → 11 new ffmpeg
edit nodes (21 total), 5-template gallery (B-Roll Remix ran green in-browser first try:
12.00s 1080×1920 from the 3 Fallacié clips, $0), editor UX wave (QuickAdd drag-to-add,
Cmd+D, typed+animated edges, ms/credit badges, autosave, graph switcher). local-phantom
@ 378aa44.

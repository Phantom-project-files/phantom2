# Audio solutions — ranked memo (2026-08-08)

Deep-research sweep, 106 agents: 5 angles → 24 sources fetched → 116 claims extracted →
top 25 adversarially verified (3-vote panels): **19 confirmed, 6 refuted, 0 unverified**.
All Meta pages verified LIVE 2026-08-08 (several needed rendered-browser fetches — Meta
bot-walls curl). Supersedes parts of `audio-and-deployment-2026-07-03.md`.

---

## THE HEADLINE — the stall's premise is dead

**"No API can attach IG library music to a published reel" is FALSE since ~May 18, 2026.**
Meta's Content Publishing API now accepts an `audio_configuration` object on the REELS
container in the normal create-container→publish flow:

```
audio_configuration={"audio_id":"587784541076604","audio_volume":80,"video_volume":50}
```

- `audio_id` comes from the **Audio API search endpoint (`GET /ig_audio`) — the exact
  endpoint `lib/edit/trending.js` already wired** (verified live on v22.0, trending-by-
  default, `is_ads_eligible` flag present, temp `download_url` ~1.5d for beat analysis).
- Not vaporware: **Metricool** ships Reels-with-audio scheduling "as of May 18, 2026";
  **bundle.social** exposes it as `musicSoundInfo.musicSoundId` (+volumes, start/end) on
  REEL posts; **Enji** press release (2026-07-23): Meta "updated its API in May 2026,
  opening Instagram's audio library to third-party platforms."
- Why July research missed it: Meta's main content-publishing guide still contains ZERO
  mentions of audio/music — the feature lives only on the separate "Instagram Audio API"
  page. The change went live ~6 weeks before we researched and we read the wrong page.
- Constraints: **Facebook-Login-connected IG Business/Creator accounts** (matches our
  planned Meta-app + System-User setup); `instagram_basic` + `instagram_content_publish`;
  REELS only; **third-party-authorized catalog subset** (narrower than in-app); no
  pre-publish preview via API (irrelevant — our gallery preview-mux already shows the cut).
- Verified 3-0 across three merged claims. Sources: developers.facebook.com Audio API page
  (both URL paths), bundle.social/instagram-music-api + their OpenAPI spec, Enji PR,
  Metricool help center.

**Product meaning:** the promise that died — "client reels go up WITH a real trending IG
sound, zero client effort" — is now technically deliverable. Publishing to Phantom's OWN
account works in Dev mode today (no App Review); publishing to CLIENT accounts needs Meta
App Review (advanced `instagram_content_publish`) **or** an already-reviewed intermediary
(bundle.social) as the deploy adapter.

## Other verified context (short)

- **IG trending/licensed library**: still "personal, non-commercial use" only; "certain
  business accounts and certain types of posts do not have access" at all; region-gated;
  NO 2025–26 Meta expansion found. → The instruction-card approach was both legally
  unsound for brand content and operationally unreliable. It's also now unnecessary.
- **Meta Sound Collection**: live, 14k+ tracks, ToS grants commercial use incl. ads — but
  ON Meta platforms only ("may not... use... separately from the Meta Company Products"),
  single-party grant (create AND upload AND distribute), **no sublicense path**. Baking SC
  tracks into ZIP files we hand to clients = in tension with / arguably breaches the terms.
  Clean shape: the CLIENT (or their connected account) is the attaching party on-platform.
  Whether SC tracks are addressable via `audio_configuration` is UNVERIFIED — test it.
- **ElevenLabs Eleven Music API**: GA, self-serve, `POST /v1/music` (3s–10min,
  `composition_plan` for genre/mood/structure, `force_instrumental`, music_v1/v2). API on
  EVERY paid tier; eligibility Scale = org <10 employees (1,100 gen-min/mo), Business = <50
  (4,800). ~$0.30–0.40/generated-minute (secondary sources, post-May-2026 price cut) →
  **~5–20¢ per 15–30s reel track**. Licensed training (Merlin, Kobalt, Believe, Landr,
  SourceAudio); no music-copyright suit found against them. Bounds that matter:
  - Paid tiers: all online/offline commercial use EXCEPT film/TV/radio/studio games →
    IG brand reels are in scope. ("Unqualified rights on every plan" was REFUTED — Free
    tier can't even download; eligibility gates are enforceable w/ output forfeiture.)
  - **Two hard prohibitions on all self-serve tiers**: Reseller Rights, and "Music
    Libraries & Repositories" (a catalog of outputs licensed/made available to third
    parties). → Bespoke track per reel baked into the finished client video = permitted;
    turning `audio_tracks` into a reusable cross-client catalog = prohibited; internal
    reuse cache = untested gray, avoid for now (per-client generation only).
  - Sector prohibitions (firearms, tobacco, pharma, adult, religious orgs, political
    advocacy) → add to client intake screening.
  - Prompt bans: no artist names, song titles, lyrics (keeps us on the safe side anyway).
  - Open seam: SaaS-bakes→client-posts isn't explicitly addressed in public terms
    ("Customer Solution"/"Bundled Service" definitions exist in /music-terms) → get
    written confirmation. Note their printed v1-terms URL 404s; governing docs are
    /music-terms (2026-05-26) + /eleven-music-model-specific-terms.
- **Rivals' legal state**: Suno — UMG/Sony litigation active, **LOST GEMA (Munich,
  2026-07-31)** on unlicensed training + outputs reproducing real songs; WMG settled.
  Udio — UMG/WMG settled, Sony not; AFM suit targets the settlements. → ElevenLabs is the
  clean pick by a wide margin.
- **Soundalike doctrine** (the legal line for trend-replication): melody/lyric copying
  carries "controlling weight"; vibe/genre/BPM/energy similarity alone is not actionable
  (Skidmore en banc 2020, Gray v. Hudson, 2nd Cir. Sheeran 2024, Levitating). Blurred
  Lines is NOT overruled → residual 9th-Cir. selection-and-arrangement risk; don't stack
  many distinctive elements of one specific song. Never mimic a distinctive VOICE
  (Midler/Waits; ELVIS Act). Rule: **match the vibe, never the melody/hook/voice.**
- **Epidemic Sound**: only the floor survived — free Partner-API tier grants end users a
  PERSONAL license (no monetization/ads) = insufficient for brand reels; commercial rights
  flow via ES Connect to end users with paid subs. Gating/pricing/license-holder claims
  were refuted IN BOTH DIRECTIONS → July's "top pick" is unproven; needs a sales email,
  not more web research. **Soundstripe: zero claims survived** — unknown.
- **Zero verified coverage** (open ground, not dead ends): competitor SaaS audio
  precedent (Arcads/Creatify/etc.), VO-vs-music performance evidence, TTS rights detail,
  Mubert/Stable Audio/Beatoven/Soundraw/Loudly refresh.

---

## THE SOLUTIONS (6 — ranked; fewer + effective per operator ask)

### S1 · Attach REAL trending IG audio at publish via `audio_configuration`  ⭐ the unlock
**What:** finish the existing runbook (Meta app + System User token, ~1 hr) → sync
ads-eligible trending via the already-built `trending.js` → publish reels with
`audio_configuration` so they go up WITH the native trending sound. Beat-cut the video to
the same track pre-publish (we already do) so cuts land on drops.
**Legal:** the audio never touches our files — IG attaches it on-platform from its own
licensed catalog. Filter `is_ads_eligible=true` (business-safe subset; whether plain
"third-party-authorized" implies brand clearance is an open question — stay on the flag).
**Cost:** $0/reel. **Effort:** S (adapter exists; add one object to the publish call).
**Reach:** own/test account TODAY (Dev mode, no review). Client accounts = App Review OR
route through bundle.social (reviewed, exposes the same field + trending search; also
covers TikTok CML `song_clip_id` — one adapter, two platforms). Revisit "auto-deploy
shelved" — this makes deploy the star feature, not a nice-to-have.

### S2 · ElevenLabs Eleven Music — bespoke trend-replica tracks, baked in  ⭐ build first
**What:** the "replicate the viral sound" lane. Trending ref (from S1's sync) →
`detectCuts`/BPM+energy profile (built) → LLM writes a `composition_plan` (genre, BPM,
energy, structure — never artist/song names) → `POST /v1/music` → beat-cut + bake. Every
reel ships WITH owned audio — ZIP delivery finally has sound, legally, on every platform.
**Legal:** cleanest AI option (licensed training, no suits); bespoke-per-reel = permitted
commercial use; no cross-client catalog; add sector screen at intake; email them for
written SaaS→client confirmation.
**Cost:** ~5–20¢/reel; Scale tier covers ~2,000+ tracks/mo. **Effort:** M (new provider in
`lib/edit/`, prompt-gen from briefs' `audio_vibe` + trend profile; `audio_tracks`
source='ai_gen' already planned in July design).

### S3 · Meta Sound Collection — the $0 cleared catalog, client-attach shape only
14k+ commercial-cleared tracks incl. ads — but platform-locked + non-sublicensable, so
DON'T bake into ZIPs. Use as: (a) test whether SC tracks resolve via `ig_audio`/
`audio_configuration` → if yes they ride S1's rails as guaranteed-commercial-safe picks;
(b) fallback instruction cards pointing at SC tracks (the one catalog business accounts
can always use in-app). **Cost:** $0. **Effort:** XS–S. Demoted from July's "bake it in."

### S4 · Epidemic/Soundstripe partner deal — licensed HUMAN catalog for baking
The only lane that would let ZIPs carry recognizable human-made licensed music. Reality
unverified in both directions → **two sales emails** (Epidemic partner team, Soundstripe
API) asking: platform-level license for SaaS-baked client-published content? pricing? who
holds the license? Decide on their answers. If it requires per-client ES subscriptions →
dead at our price point; if a flat partner license exists → premium bake lane. **Effort
now:** two emails. Park otherwise.

### S5 · Voiceover-led audio — AI VO hook + S2 music bed (experiment, don't believe yet)
Research returned zero verified claims on VO-vs-music performance — so treat as an A/B
test, not a lane. Briefs already contain hooks; ElevenLabs TTS (same vendor/plan family)
reads the hook, ffmpeg sidechain-ducks the bed. Many top DTC reels are VO-led; if it wins
QC/engagement it becomes the default and makes trending audio matter less. **Cost:**
~cents/reel. **Effort:** S–M (a day: TTS call + ducking in `assemble.js`).

### S6 · TikTok CML native-attach lane (later, platform expansion)
July finding stands: TikTok draft/inbox mode + Commercial Music Library is real, and
bundle.social exposes CML track selection by `song_clip_id`. When Phantom adds TikTok,
the same bundle.social adapter from S1 covers it. Nothing to do now.

## Kill list (stop considering)
- ✂️ Instruction cards naming **consumer trending** sounds — legally unsound for brand
  content, unreliable per-account/region, and now unnecessary (S1). SC-track cards (S3b)
  are the only card variant that survives.
- ✂️ Baking Meta Sound Collection into ZIP deliveries — platform-lock breach.
- ✂️ Suno / Udio — litigation posture (GEMA loss on actual-song reproduction; partial
  settlements). Revisit only after full settlements + clean API terms.
- ✂️ Lickd (YouTube-only), Mubert self-serve (export sublicense gated at $499/mo tier —
  July finding, unchallenged), Seedance `generate_audio` (already forced off).
- ✂️ Ripping/baking unlicensed trending audio — unchanged, permanent.

## Recommended stack (the 3 that matter)
1. **S2 NOW** — no external dependencies, un-silences every delivery this week, cents/reel.
2. **S1 in parallel** — 1-hr runbook click-through → live `verify-trending-live.js` → test
   `audio_configuration` on Phantom's own IG. If the ads-eligible subset looks decent,
   it's the headline feature; choose own-App-Review vs bundle.social after the test.
3. **S5 as an A/B** on the next real batch (Blue Bottle's pending pieces are candidates).
Plus the two S4 emails + one ElevenLabs confirmation email — 30 min total, async.

## Open questions (carried)
1. Does `audio_configuration` accept any `/ig_audio` result for a business account?
   `is_ads_eligible` subset size/freshness in practice? SC tracks addressable? → empirical,
   S1 test answers all three.
2. ElevenLabs written confirmation: bespoke-per-reel baked into client-published videos on
   Scale/Business tier OK? Is an internal per-client reuse cache inside the "Music
   Libraries & Repositories" prohibition?
3. Epidemic/Soundstripe actual partner terms (outreach, not web).
4. Competitor audio precedent + VO performance evidence (unresearched; S5 A/B gives us
   our own data instead).

## Load-bearing sources
- Meta Instagram Audio API (audio_configuration + /ig_audio): developers.facebook.com/docs/instagram-platform/content-publishing/audio-api/
- Meta content-publishing guide (still silent on audio — docs fragmentation): developers.facebook.com/docs/instagram-platform/content-publishing/
- bundle.social IG music API + OpenAPI (production proof): bundle.social/instagram-music-api
- Metricool (Reels-with-audio live 2026-05-18); Enji PR 2026-07-23 (barchart.com/story/news/3444506/)
- IG music restrictions: facebook.com/business/help/402084904469945 + facebook.com/legal/music_guidelines
- Meta Sound Collection ToS: facebook.com/sound/collection/terms
- ElevenLabs: elevenlabs.io/music-api · /docs/api-reference/music/compose · /eleven-music-model-specific-terms (2026-05-26) · /music-terms
- Suno/Udio litigation: MBW (WMG–Suno deal), Billboard, Forbes 2026-08-05 / Bird & Bird / Variety (GEMA v. Suno, Munich 2026-07-31)
- Soundalike doctrine: Skidmore v. Led Zeppelin (9th Cir. en banc 2020), Williams v. Gaye (895 F.3d 1106 + Nguyen dissent), Gray v. Hudson, 2nd Cir. Sheeran (2024), ABA ESL Fall-2025 style-prompt analysis
- Epidemic Partner API docs: developers.epidemicsite.com/docs/overview + /docs/FAQ/

*(Full claim-by-claim evidence + votes: workflow `wf_7d4fcb7f-a91` journal; caveats include
docs-fragmentation risk — the attach capability is ~3 months old and Meta may move it.)*

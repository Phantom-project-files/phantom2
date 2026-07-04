# Audio + Deployment research — findings & reshaped Lane-B design (2026-07-03)

Deep-research sweep (primary sources: TikTok & Meta developer docs, Ayrshare docs, vendor
licensing pages; each headline fact corroborated by 3–5 independent sources). Adversarial
verification re-run after a session-limit hit on the first pass.

## Two premises from our earlier design were WRONG

1. **"No API can attach native trending audio" — false on two platforms.**
   - **Instagram** now has an official **Audio API** (`GET /ig_audio`; returns *trending audio
     by default* when no query) that attaches sounds to Reels at creation time.
   - **TikTok** has a real API **draft/inbox mode** (`MEDIA_UPLOAD`) — video lands in the
     creator's TikTok app inbox to finish natively.

2. **"Trending audio is what we want" — wrong target for our customers.** Our clients are
   **business/creator accounts**, and for them native trending *consumer* audio is a licensing
   violation, not a missing feature:
   - TikTok: *"Businesses cannot use the general music library for commercial usage"* — they
     must use the **Commercial Music Library (CML)**.
   - Instagram: licensed/trending music is *"personal, non-commercial use"* only, and *"certain
     business accounts and certain types of posts do not have access to the library"* — even
     natively in-app.

   → Chasing trending consumer sounds for DTC brands is chasing something they're **not allowed
   to use**. The real targets are the **commercial-cleared** catalogs (TikTok CML, Meta Sound
   Collection) and baked-in licensed/royalty-free tracks.

## Per-platform audio matrix

| Platform | Lane A: baked licensed audio, auto-publish | Native/trending via API? | Business-account commercial audio path |
|---|---|---|---|
| **TikTok** | ✅ API requires audio baked into the file | ⚠️ No *trending-consumer* API; **CML** (1M pre-cleared songs, free) is the business path — attach natively in draft mode, or via bundle.social's `song_clip_id` API | **CML** (organic + ads). Draft mode (`MEDIA_UPLOAD`) lets client attach in-app. `autoAddMusic` auto-suggests |
| **Instagram Reels** | ✅ `media_type=REELS` + baked audio | ⚠️ Audio API exists but returns **third-party-authorized** subset; trending music is personal-use-only + blocked for many business accts | **Meta Sound Collection** (14k royalty-free, commercial-cleared incl. ads) — bake in |
| **Facebook Reels** | ✅ same as IG (Meta) | same caveat | Meta Sound Collection |
| **YouTube Shorts** | ✅ baked | YouTube Audio Library exists (not native-trending) | Baked royalty-free / YT Audio Library |
| **LinkedIn / X / Pinterest / Threads / Bluesky** | ✅ baked | ❌ none have native music catalogs | Baked audio only — Lane A only |

**Bottom line:** Lane B (draft-to-native-app) is only real on **TikTok**. Instagram has **no
draft API** (the word "draft" doesn't appear in Meta's content-publishing docs). Every other
platform is Lane A only. So the instruction-card fallback survives only for IG when a client
insists on native audio — and even then it's legally the wrong ask for a business account.

## Music library for Lane A (baked-in, at scale)

| Library | Agency/client rights | API for programmatic pulls | Content-ID safety | Price |
|---|---|---|---|---|
| **Epidemic Sound** ✅ top pick | Business tier = *"agency client work licensing"*; Pro = *"sublicensing for clients"* | **Partner API** (full-catalog) + **MCP server** | Cleared IG/TikTok/YT/FB | Pro $17/mo, Business $30/mo (yearly) |
| **Soundstripe** ✅ strong 2nd | API pre-cleared commercial + **indemnification** | Dedicated **B2B API** (search/curation/playback/metadata) | Cross-channel clearance | ~$120k-track catalog; API = quote |
| Artlist | Pro needed for client/multi-channel; client-*production* rights unconfirmed | No open catalog API | Cleared | Higher |
| **Mubert** (AI) | Business $199/mo = *"Apps & Agency"* + sublicensing — **but export sublicense only on Startup+ $499/mo** | REST gen API | Owns rights, DMCA-free, forbids Content-ID registration | $49 / $199 / $499 |
| Suno (AI) | Paid tier assigns output rights, **but disclaims copyright vesting** + duplicate-output risk → Content-ID collisions at scale | API (limited) | Risky at scale | Pro/Premier paid |
| Beatoven (AI) | "cleared for commercial use"; agency terms unstated | Text-prompt gen **API** | Claimed clear | API pricing |
| Lickd | ❌ individual-creator only; **clears YouTube Content-ID only** (not IG/TikTok) | — | Wrong platform coverage | — |

**Pick: Epidemic Sound Partner API** for baked licensed music (explicit agency/client-work +
programmatic + all-platform clearance). **Free commercial catalogs to layer in at $0:** Meta
Sound Collection (IG/FB) and TikTok CML (TikTok). Keep the AI-gen route (Mubert Business, or the
existing Fal/audio pipeline) as an infinite-variety fallback.

## Deployment: STAY ON AYRSHARE

Ayrshare already does **both lanes for TikTok** — no migration needed:
- **Lane A:** normal auto-publish with baked audio (today).
- **Lane B:** `tikTokOptions.draft: true` → post lands in the client's TikTok inbox
  (*"Your content from Ayrshare is ready"*), stays `pending` until they finish it natively
  (where CML/native audio is one tap away). Also `autoAddMusic: true` for auto-suggested music.

What Ayrshare does **not** expose: CML track *selection* by `song_clip_id`. Only **bundle.social**
surfaced as offering that (query CML by genre/date → attach `song_clip_id` via API). Not worth
switching platforms for — draft-mode native attach covers the same need without an API-side track
picker, and everything else (IG/FB/YT/LinkedIn/X/Pinterest) is Lane A anyway.

Verdict: **keep Ayrshare.** The gap (programmatic CML selection) is a nice-to-have addressable
later via bundle.social as a TikTok-only side-adapter if it ever matters.

## Reshaped Lane-B design (supersedes the 2026-07-03 first draft)

- **Drop "trending consumer audio" as a concept** — illegal for business accounts. Reframe the
  premium option as **"native-sound kit"**: the client finishes a TikTok draft with a **CML**
  track (or their own trending-but-cleared sound) in-app.
- **Lane A (default, all platforms):** bake an **Epidemic Sound / Meta Sound Collection / CML /
  AI-gen** track into the master → auto-publish via Ayrshare. Posts + reels both hands-off.
  This is the honest 95% path and it's fully legal.
- **Lane B (TikTok only, real API path):** render the **silent master**, publish via Ayrshare
  with `draft: true` → lands in the client's TikTok inbox → they attach CML/native audio and
  publish. No instruction card needed on TikTok — the draft *is* the handoff. Gallery still
  shows a preview.
- **Instagram "native audio" (rare):** no draft API exists → keep the **silent master + preview +
  instruction card** fallback, but label it clearly as personal-use-only / not for the brand's
  primary commercial posts. Discourage it; default IG to Meta Sound Collection baked in.

### Build implications (vs. the first draft)
- Ayrshare adapter: add `draft`/`autoAddMusic` passthrough in `tikTokOptions` — small.
- deploy_piece: route TikTok reels tagged "native-sound" through draft mode; everything else
  Lane A. Posts always auto-publish.
- audio_tracks: add `source` kinds — `epidemic` (API-pulled), `meta_sound_collection`, `tiktok_cml`
  (reference-only), `ai_gen`, `operator_upload`. Most are baked (Lane A); only `tiktok_cml` +
  operator-flagged "native" trigger Lane B draft mode.
- The gallery preview-mux + instruction-card work shrinks to **IG-only** — TikTok's draft handoff
  replaces it.
- Console Audio panel (the gap the audio agent found) still needed for `operator_upload` +
  Epidemic API browse.

## Sources (primary)
- TikTok CML: ads.tiktok.com/help/article/commercial-music-library
- TikTok Content Posting API (draft/inbox + direct post): developers.tiktok.com/doc/content-posting-api-get-started-upload-content
- Instagram Audio API: developers.facebook.com/docs/instagram-platform/content-publishing/audio-api/
- Instagram music restrictions: help.instagram.com/402084904469945
- Instagram content publishing (no draft): developers.facebook.com/docs/instagram-platform/content-publishing/
- Ayrshare TikTok (draft/autoAddMusic): ayrshare.com/docs/apis/post/social-networks/tiktok
- Epidemic Partner API / Soundstripe API / Mubert / Suno ToS / Beatoven / bundle.social CML API

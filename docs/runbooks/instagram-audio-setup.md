# Runbook — go live on the Instagram Audio API (trending fetch)

Wires `lib/edit/trending.js` from mock → live. Everything here is done by YOU in your own
Meta account (creating the app, connecting Instagram, and generating a token can't be
automated — they require your login and your OAuth authorization). When you're done you paste
two values into `backend/.env` and run one check.

## The two things that save you hours

1. **You only need ONE Instagram account — Phantom's own.** The trending fetch (`GET /ig_audio`)
   is a single-account call; it does NOT publish to customer accounts, so it does **not** need
   Meta App Review or Advanced Access. The app owner's own connected professional IG account
   works while the app is in Development mode. (App Review only matters if/when auto-deploy
   publishes to *other people's* accounts — that's the shelved feature, not this.)
2. **Use a System User token, not a personal one.** Personal user tokens expire (hours →
   ~60 days even when long-lived). A **System User** token from Meta Business Settings can be
   generated with **no expiry**, needs no logged-in browser session, and is the correct
   production credential. This avoids building token-refresh plumbing entirely.

## Prerequisites
- A Facebook **Page** linked to an **Instagram professional** (Business or Creator) account.
  If Phantom doesn't have one yet: convert/þmake an IG account professional (IG app → Settings
  → Account type), and link it to a FB Page (Page → Settings → Linked accounts → Instagram).
- A **Meta Business** portfolio (business.facebook.com) — free.

## Steps

### 1. Create the app  ·  developers.facebook.com/apps
- **Create App** → use case **"Other"** → type **Business** → attach your Business portfolio.
- Note the **App ID** (you don't put it in .env, but you'll need it in Business Settings).

### 2. Add the Instagram product
- In the app dashboard → **Add product** → **Instagram** (the Graph-API/"Instagram" product,
  since `ig_audio` lives on `graph.facebook.com`). Complete its setup wizard, connecting the
  Page + IG professional account from prerequisites.

### 3. Get the Instagram professional-account user id
- Open **Graph API Explorer** (developers.facebook.com/tools/explorer), pick your app, generate
  a User token with `pages_show_list`, then:
  - `GET me/accounts` → find your Page, copy its `id`.
  - `GET {page-id}?fields=instagram_business_account` → copy `instagram_business_account.id`.
  - **That IG business-account id is `IG_AUDIO_USER_ID`** (NOT the page id).

### 4. Generate the token (recommended: System User)
- **business.facebook.com → Business Settings → Users → System Users → Add** (name it e.g.
  `phantom-audio`), role **Admin** or **Employee**.
- **Add Assets** → assign the **app** and the **Page** (and the IG account) to this system user.
- **Generate new token** → pick the app → set **Token expiration: Never** → select scopes
  **`instagram_basic`** and **`instagram_content_publish`** (add `pages_show_list` /
  `business_management` if the generator requires them) → **Generate**.
- Copy the token once (it's shown once). **That is `IG_AUDIO_ACCESS_TOKEN`.**

### 5. Paste into `backend/.env` and go live
```
IG_AUDIO_ACCESS_TOKEN=<the system-user token>
IG_AUDIO_USER_ID=<the instagram_business_account id from step 3>
# META_GRAPH_VERSION / IG_AUDIO_BASE / IG_AUDIO_MODE — leave blank (defaults: v22.0,
# https://graph.facebook.com, and auto-live once token+user are set)
```
Then, from `backend/`:
```
node scripts/verify-trending-live.js     # hits ig_audio read-only, prints trending sounds or the exact error
```
- ✅ prints trending titles + `downloadable=true` → you're live.
- ❌ prints the Graph API error → the script lists the usual fixes (expired token / missing
  scope / wrong id). `META_GRAPH_VERSION` and `IG_AUDIO_BASE` are env-tunable if Meta bumps the
  version, so a version change is a `.env` edit, not a code change.

### 6. Restart + first sync
```
npm start                                # picks up live mode
# then, logged into the operator console, POST:
#   /api/admin/audio/sync-trending  {"audio_type":"music","limit":8,"ads_only":true}
```
`ads_only:true` keeps only `is_ads_eligible` sounds — the business-safe subset. Synced tracks
land in the library (source='trending_ig'); every reel assembled after that is cut + previewed
against a real trending sound, and its download instruction names it with the in-app link.

## Notes
- The fetch pulls trending audio *authorized for third-party use* — the API's selection can be
  smaller than what you see scrolling the app natively (Meta's caveat). `ads_only` narrows it
  further to the commercially-safe set, which is what Phantom's business clients need anyway.
- Re-syncing is idempotent (dedup by the sound's permalink), so a daily sync just adds what's new.
- Optional later: a cron that calls the sync endpoint each morning so the trending pool stays
  fresh (the routine can be a scheduled cloud agent, or a `jobs` entry — say the word).
- Nothing here bakes trending audio into a download; delivery stays silent + instructions
  (that's the whole reason the fetch exists — the customer attaches the sound natively).

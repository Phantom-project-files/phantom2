# Runbook — Stripe go-live (PLAN.md post-build item 4)

Written 2026-07-03 after test-mode verification (25/25 offline checks + smoke ALL PASS).
Code surface: `backend/lib/payments.js` + the `/webhook/stripe` route in `backend/server.js`.

## What the code actually uses (keep the dashboard config this minimal)

- **API calls made:** exactly one — `POST https://api.stripe.com/v1/checkout/sessions`
  (hosted Checkout; `mode=payment` for Standard one-time, `mode=subscription` with
  inline `price_data[recurring][interval]=month` for Premium/Ultra/Overkill).
  **No Products/Prices are pre-created in the dashboard** — prices are inline
  `price_data`, driven by `lib/tiers.js`. No customer objects, no payment intents
  touched directly.
- **Webhook events consumed:** exactly one — `checkout.session.completed`.
  Everything else is logged `stripe.webhook_ignored` and 200'd. The handler reads
  `data.object.metadata.intake_id` (fallback `client_reference_id`) and
  `metadata.plan`, then unlocks via `markIntakePaid()` → script_gen job + email.
- **Webhook route:** `POST /webhook/stripe` (raw-body mounted; gate-allowlisted).
- **Env consumed:**
  - `STRIPE_SECRET_KEY` — read in `createCheckout()` (Bearer) and by `mode()`:
    no key → mock mode (fake `cs_mock_*` sessions, $0). `STRIPE_MODE` overrides.
  - `STRIPE_WEBHOOK_SECRET` — read in `verifyStripeSignature()`. Unset → unsigned
    accepted in dev, **refused when `NODE_ENV=production`** (hardening added
    2026-07-03; before that an unsigned prod webhook was an unauthenticated unlock).
  - `STRIPE_PUBLISHABLE_KEY` — **currently read nowhere** (hosted Checkout redirect,
    no Stripe.js). Set it anyway at launch so a future client-side embed can't ship
    with a test key by accident, but nothing breaks if you skip it.
- **API version:** nothing is pinned (no SDK, no `Stripe-Version` header) — calls run
  on the account's default version. All fields used (checkout sessions, inline
  price_data, metadata, client_reference_id) are stable across every recent version;
  the signature scheme (`t`/`v1` HMAC-SHA256, 300 s tolerance) matches Stripe's spec
  and the official SDK default. No drift risk at go-live.

## Pre-launch rehearsal (test mode, localhost — do this first)

Test keys are already in `backend/.env`. The missing piece locally is the webhook
signature loop; the Stripe CLI closes it:

```sh
brew install stripe/stripe-cli/stripe     # once
stripe login                              # once — pairs with the Stripe account
stripe listen --forward-to localhost:3020/webhook/stripe
# → prints "Ready! ... webhook signing secret is whsec_..." — put that value in
#   backend/.env as STRIPE_WEBHOOK_SECRET and restart the server.
```

Then either drive the real funnel to a plans page and pay with card
`4242 4242 4242 4242` (any future expiry / any CVC), or fire a synthetic event:

```sh
stripe trigger checkout.session.completed
```

Verify in the console/logs: `stripe.webhook_*` shows **no** `webhook_unsigned`
warnings, `funnel.paid` fires, the intake flips to `paid`, and a `script_gen` job
enqueues. Negative check: `curl -X POST localhost:3020/webhook/stripe -H
'Content-Type: application/json' -d '{"type":"checkout.session.completed"}'`
must now return 400 (`missing stripe-signature header`).

When done rehearsing, remove the CLI's `whsec_` from `.env` (or leave it — it only
matches `stripe listen` sessions).

## Go-live: Stripe dashboard (operator, ~10 min)

1. **Activate the account** — dashboard.stripe.com → complete the business profile
   (legal entity, bank account, statement descriptor). Until this is done there are
   no live keys.
2. **Get live keys** — Developers → API keys (toggle **off** "Test mode"):
   copy `sk_live_...` (secret) and `pk_live_...` (publishable).
3. **Create the webhook endpoint** — Developers → Webhooks → **Add endpoint**
   (live mode!):
   - Endpoint URL: `https://online-phantom.com/webhook/stripe`
     (pre-cutover: `https://phantom2.fly.dev/webhook/stripe` — after the domain
     cutover, **edit the endpoint URL**, don't create a second one).
   - Events: select **only** `checkout.session.completed`.
   - API version: leave at the default/latest.
   - Create, then click **Reveal** on the signing secret → copy `whsec_...`.

## Go-live: Fly secrets (operator, ~2 min)

```sh
fly secrets set -a phantom2 \
  STRIPE_SECRET_KEY='sk_live_...' \
  STRIPE_PUBLISHABLE_KEY='pk_live_...' \
  STRIPE_WEBHOOK_SECRET='whsec_...'
```

`fly secrets set` restarts the machine. Confirm `NODE_ENV=production` and
`PUBLIC_BASE_URL=https://online-phantom.com` are set (checkout success/cancel URLs
derive from the request base URL / PUBLIC_BASE_URL). Do **not** set `STRIPE_MODE` —
with a secret key present the code is live automatically; `STRIPE_MODE=mock` would
silently fake payments in prod.

## Post-deploy verification (first 10 minutes live)

1. Dashboard → Webhooks → the endpoint → **Send test event** is test-mode-only;
   instead watch the endpoint's "Events" tab for the first real delivery, or run a
   $1-style live smoke: buy Standard yourself, then immediately **refund** it in the
   dashboard (Payments → refund).
2. In the phantom2 console/logs confirm: no `stripe.webhook_unsigned` /
   `webhook_rejected` warnings, `funnel.paid` fired, intake `paid`, script_gen ran.
3. Curl the endpoint unsigned (as above) — must 400. If it 200s, the webhook secret
   didn't land; fix before taking money.

## Known limitations (accepted for launch — revisit with real volume)

- **Subscriptions unlock once, never revoke.** Only `checkout.session.completed` is
  consumed — `invoice.payment_failed` / `customer.subscription.deleted` do nothing,
  so a canceled Premium keeps its entitlement until handled manually (dashboard →
  cancel + admin console). Add those events to the endpoint only when the code
  consumes them.
- **Unknown intake id in a live event → route 500s** and Stripe retries for ~3 days
  (self-heals for ordering races; a truly bogus id will page via
  `stripe.webhook_error` logs).
- **Signing-secret rotation:** the verifier checks a single `v1` value, so during a
  dashboard secret roll (both secrets active) some deliveries may 400 until the new
  `whsec_` is in Fly. Rotate by setting the new secret immediately, not by relying
  on the overlap window; Stripe retries the 400'd deliveries.

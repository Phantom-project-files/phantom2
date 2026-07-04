# Runbook: online-phantom.com → phantom2 domain cutover (PLAN item 8)

Point `online-phantom.com` at the Phantom 2.0 Fly app (`phantom2`) once parity is
verified. v1 (Fly app `online-phantom`) stays running untouched until rollback is
no longer plausible — rollback is a DNS flip, nothing more.

**Prereq:** PLAN item 5 done — `backend/scripts/provision-phantom2.sh` ran clean,
`https://phantom2.fly.dev` is live and smoke-checked.

---

## 1 · Parity checklist — ALL boxes before touching DNS

- [ ] **Prod smoke** — `curl https://phantom2.fly.dev/health` → `{"ok":true}`;
      `curl https://phantom2.fly.dev/version` → expected version + git sha;
      `/app/admin-login.html` returns 200; `/` serves coming-soon (gate on).
- [ ] **Boot line sane** — `fly logs -a phantom2` shows
      `storage=r2 … coming_soon=true` and the intended `CLAUDE_MODE` / `mock_media`.
- [ ] **One promoted tenant renders** — run the local pipeline end-to-end
      (`CLAUDE_MODE=claude_code`, `STORAGE_BACKEND=local`), then:
      `node backend/scripts/promote-tenant.js <slug> --to https://phantom2.fly.dev --user <admin> --pass <pass>`
      → rows import (ids remapped), media uploads to R2, and the tenant's reels/posts
      open and play from prod signed URLs in the console. This exercises DB, R2 keys,
      signed-URL serving, and admin auth in one move.
- [ ] **Google OAuth prod redirect URIs registered** — the OAuth client must list
      BOTH `https://phantom2.fly.dev/auth/google/callback` AND
      `https://online-phantom.com/auth/google/callback` (the callback URL is derived
      from the request Host / `PUBLIC_BASE_URL`, which changes at cutover). Consent
      screen published. Live-test signup on phantom2.fly.dev before cutover.
- [ ] **Stripe live** (PLAN item 4) — decide: cut over with test keys (fine while
      `COMING_SOON=1`) or go live first. For live: swap `STRIPE_SECRET_KEY` to
      `sk_live_…`, create a **live-mode** webhook endpoint
      `https://online-phantom.com/webhook/stripe`, and set its `whsec_…` as
      `STRIPE_WEBHOOK_SECRET` (test and live signing secrets differ). If v1 has a
      webhook on this domain, plan to disable it at cutover — after DNS moves,
      Stripe deliveries to the domain hit phantom2.
- [ ] **COMING_SOON strategy decided** — the gate is independent of DNS:
      cutting over with `COMING_SOON=1` is safe (public sees coming-soon;
      `/health` `/version` `/webhook/*` `/api/events` `/admin/auth/*` stay open).
      Flip to `0` (public launch) as its own later deploy — don't couple the two changes.
- [ ] **Audio library uploaded** (PLAN item 6) — reels need operator tracks.
- [ ] **ADMIN_PASSWORD rotated** (PLAN item 2 note) — prod password must not be
      the one that sat in the plaintext rtf.
- [ ] **v1 inventory** — note anything on online-phantom.com that outsiders still
      hit (v1 Ayrshare callbacks, old Stripe webhooks, tenants' bookmarked links).
      After cutover those paths land on phantom2 and 404/503 — confirm that's acceptable.

## 2 · Lower the blast radius (do this a day early)

At your DNS host (wherever online-phantom.com's nameservers point — likely the
registrar or Cloudflare):

1. Find the current records for `online-phantom.com` and `www` and **record them
   verbatim** (they are the rollback): type, name, value, TTL.
2. Drop their TTL to **300 s (5 min)**. If TTL was 86400, do this ≥24 h before
   cutover so the old long TTL has expired from resolvers by the time you flip.

## 3 · Attach the domain to phantom2 (safe before DNS — no traffic moves yet)

```sh
fly certs add online-phantom.com -a phantom2
fly certs add www.online-phantom.com -a phantom2   # if www is served
fly ips list -a phantom2                            # note the dedicated IPv4 + IPv6
fly certs show online-phantom.com -a phantom2       # shows the validation state + expected records
```

Fly will show an **acme-challenge CNAME** for pre-issuance validation. Add it at the
DNS host now — the cert is then issued *before* any traffic moves (zero-downtime TLS):

```
_acme-challenge.online-phantom.com  CNAME  online-phantom.com.<...>.flydns.net.
```

Wait until `fly certs show` reports the cert issued.

Note: v1 (`online-phantom` app) may still hold `fly certs` for this hostname.
Fly hostnames are account-unique — if `certs add` complains, `fly certs remove
online-phantom.com -a online-phantom` first (v1 keeps serving existing TLS
connections until DNS moves; this is the point of no easy return for cert state,
so do it inside the cutover window).

## 4 · DNS flip (the actual cutover)

Per Fly docs, apex domains use A + AAAA to the app's dedicated IPs; `www` can CNAME:

```
online-phantom.com      A      <phantom2 dedicated IPv4 from `fly ips list`>
online-phantom.com      AAAA   <phantom2 IPv6>
www.online-phantom.com  CNAME  phantom2.fly.dev.
```

(If DNS is on Cloudflare: set records **DNS-only / grey cloud** — Fly terminates
TLS; proxied-orange adds a second proxy layer and breaks `fly certs` validation.
CNAME flattening at the apex to `phantom2.fly.dev` also works there, but explicit
A/AAAA is the predictable choice.)

Keep TTL at 300 until the cutover is declared done.

## 5 · Post-flip config + verification

1. **Flip PUBLIC_BASE_URL** — `backend/fly.toml` [env]:
   `PUBLIC_BASE_URL = "https://online-phantom.com"` → `fly deploy`. This is what
   Fal webhooks, OAuth redirects, and invite links are built from; until this
   deploy they still say phantom2.fly.dev (which keeps working — fly.dev stays
   attached — so ordering is forgiving).
2. Verify (from a network that has picked up new DNS — `dig online-phantom.com`):
   - `curl -sS https://online-phantom.com/health` → `{"ok":true}`
   - `curl -sS https://online-phantom.com/version` → **2.0's version**, not v1's
   - admin login works on the domain; console loads
   - a promoted tenant's media plays (signed URLs fine — they point at R2, not the domain)
   - OAuth signup on the domain completes (redirect URI from §1 does its job)
   - Stripe dashboard → webhook endpoint → "Send test event" → 200
3. Watch `fly logs -a phantom2` for 30–60 min: no cert errors, no webhook 4xx,
   `/webhook/fal` deliveries arriving (if media gen is live).

## 6 · Rollback plan (keep v1 running until you'd never use this)

DNS is the only thing that moved, so rollback = restore §2's recorded records:

1. Re-point `online-phantom.com` A/AAAA (or CNAME) back to the v1 values recorded
   in §2. With TTL 300, resolvers converge in ~5–10 min.
2. If v1's cert was removed in §3: `fly certs add online-phantom.com -a online-phantom`
   and re-do the acme-challenge for v1 (minutes, since DNS already points there).
3. Revert `PUBLIC_BASE_URL` in fly.toml to `https://phantom2.fly.dev` + `fly deploy`
   (phantom2 stays reachable at fly.dev for debugging — nothing on it breaks).
4. If Stripe live webhook was re-pointed: re-enable v1's endpoint / disable phantom2's.
5. Post-mortem before retrying.

**TTL guidance:** stay at 300 s through at least 48 h of clean running, then raise
to 3600–14400. Only after that do you consider decommissioning v1 (export its data
first; its Fly volume dies with the app).

## 7 · Aftercare

- [ ] Raise TTL (above) once stable.
- [ ] Google OAuth: leave both redirect URIs registered (fly.dev URI is the debug door).
- [ ] R2 custom domain (optional, later): storage.js notes a planned
      `cdn.online-phantom.com` for signed URLs once DNS lives on Cloudflare —
      separate change, not part of this cutover.
- [ ] Mark PLAN.md item 8 ✅ with the date.
- [ ] Decide v1 decommission date; until then it costs one small Fly machine.

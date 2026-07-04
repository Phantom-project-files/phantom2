#!/usr/bin/env bash
# scripts/provision-phantom2.sh — Fly.io + R2 provisioning for Phantom 2.0
# (PLAN.md post-build item 5). Operator-supervised: run it, read each echoed
# step, confirm the output looks right before moving on.
#
#   DRY RUN (default — prints every command, executes nothing, $0 spend):
#     backend/scripts/provision-phantom2.sh
#
#   REAL RUN (creates billable resources — app, volume, deploy):
#     DRY_RUN=0 backend/scripts/provision-phantom2.sh
#
# Idempotent: every create step checks for the resource first and skips if it
# already exists, so re-running after a partial failure is safe.
#
# Prereqs (the script verifies these, it does not install anything):
#   - flyctl installed + `fly auth whoami` succeeds
#   - backend/secrets.prod.env filled in (copy secrets.prod.env.example)
#   - wrangler (optional) for R2 bucket creation; otherwise dashboard steps print
#
# What this script does NOT do (operator-only, see the echoed manifest):
#   - create the Cloudflare R2 API token (dashboard only)
#   - register the Google OAuth prod redirect URI
#   - create the Stripe webhook endpoint
#   - anything to do with online-phantom.com DNS (that's docs/runbooks/domain-cutover.md)

set -euo pipefail

# ── knobs ─────────────────────────────────────────────────────────────────────
DRY_RUN="${DRY_RUN:-1}"          # 1 = print only (default). 0 = execute.
APP="${APP:-phantom2}"
REGION="${REGION:-iad}"          # iad = matches fly.toml primary_region. Chosen
                                 # for proximity to Fal/Stripe/Anthropic US infra;
                                 # change BOTH here and fly.toml if you move it.
VOLUME="${VOLUME:-phantom2_data}"  # must match fly.toml [mounts].source
VOLUME_SIZE_GB="${VOLUME_SIZE_GB:-3}"  # SQLite only lives here (R2-first); 3 GB is generous
BUCKET="${BUCKET:-phantom2-prod}"      # must match R2_BUCKET_PROD in secrets.prod.env
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="${SECRETS_FILE:-$BACKEND_DIR/secrets.prod.env}"
BASE_URL="https://${APP}.fly.dev"

# ── helpers ───────────────────────────────────────────────────────────────────
step() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
run() {
  echo "  \$ $*"
  if [ "$DRY_RUN" = "0" ]; then "$@"; else echo "  (dry-run: not executed)"; fi
}
note() { printf '  %s\n' "$*"; }

if [ "$DRY_RUN" != "0" ]; then
  step "DRY RUN — nothing below is executed. Re-run with DRY_RUN=0 to provision."
fi

# ── 0 · preflight ─────────────────────────────────────────────────────────────
step "0/7 preflight"
command -v fly >/dev/null 2>&1 || { echo "FATAL: flyctl not installed (https://fly.io/docs/flyctl/install/)"; exit 1; }
note "fly:      $(fly version 2>/dev/null | head -1)"
note "fly auth: $(fly auth whoami 2>/dev/null || echo 'NOT LOGGED IN — run: fly auth login')"
fly auth whoami >/dev/null 2>&1 || exit 1
if command -v wrangler >/dev/null 2>&1; then
  HAVE_WRANGLER=1; note "wrangler: $(wrangler --version 2>/dev/null | head -1)"
else
  HAVE_WRANGLER=0; note "wrangler: not installed — R2 bucket step will print dashboard instructions instead"
fi
if [ ! -f "$SECRETS_FILE" ]; then
  echo "MISSING: $SECRETS_FILE"
  echo "         cp $BACKEND_DIR/secrets.prod.env.example $SECRETS_FILE && chmod 600 && fill it in."
  if [ "$DRY_RUN" = "0" ]; then exit 1; fi
  note "(dry-run: using the example file below so you can preview the full plan)"
  SECRETS_FILE="$BACKEND_DIR/secrets.prod.env.example"
fi
# refuse to continue with unfilled required secrets (empty 'KEY=' lines)
REQUIRED="ADMIN_USERNAME ADMIN_PASSWORD ANTHROPIC_API_KEY FAL_KEY R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_PROD GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET"
MISSING=""
for k in $REQUIRED; do
  grep -Eq "^${k}=..*" "$SECRETS_FILE" || MISSING="$MISSING $k"
done
if [ -n "$MISSING" ]; then
  echo "FATAL: empty/missing in $SECRETS_FILE:$MISSING"
  [ "$DRY_RUN" = "0" ] && exit 1 || note "(dry-run: continuing anyway so you can see the full plan)"
fi

# ── 1 · fly app ───────────────────────────────────────────────────────────────
step "1/7 fly app '$APP'"
if fly status -a "$APP" >/dev/null 2>&1; then
  note "app '$APP' already exists — skipping create"
else
  # NOT `fly launch` — launch rewrites fly.toml; ours is hand-tuned deploy config.
  run fly apps create "$APP"
fi

# ── 2 · volume (SQLite only — everything else is R2-first) ───────────────────
step "2/7 volume '$VOLUME' (${VOLUME_SIZE_GB} GB, $REGION)"
if fly volumes list -a "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  note "volume '$VOLUME' already exists — skipping create"
else
  # -n 1: single machine (min_machines_running=1, no autoscale) → one volume.
  run fly volumes create "$VOLUME" --app "$APP" --region "$REGION" --size "$VOLUME_SIZE_GB" -n 1 --yes
fi

# ── 3 · R2 bucket ─────────────────────────────────────────────────────────────
step "3/7 R2 bucket '$BUCKET'"
if [ "$HAVE_WRANGLER" = "1" ]; then
  # wrangler needs Cloudflare auth: `wrangler login` (browser) or CLOUDFLARE_API_TOKEN env.
  if wrangler r2 bucket list 2>/dev/null | grep -q "name: *$BUCKET\|\"$BUCKET\""; then
    note "bucket '$BUCKET' already exists — skipping create"
  else
    run wrangler r2 bucket create "$BUCKET"
  fi
else
  note "wrangler absent — create the bucket in the dashboard (operator step):"
  note "  1. dash.cloudflare.com → R2 Object Storage → Create bucket"
  note "  2. name: $BUCKET   location: Automatic (or North America to pair with $REGION)"
  note "  3. leave public access OFF — the app serves only presigned URLs"
  note "  4. R2 → Manage R2 API Tokens → Create: 'Object Read & Write', scope to $BUCKET only"
  note "     → paste Account ID / Access Key ID / Secret into $BACKEND_DIR/secrets.prod.env"
fi
note "NOTE: bucket creation via API token requires the token to have R2 admin rights;"
note "the runtime token in secrets.prod.env should stay read/write-scoped to $BUCKET only."

# ── 4 · secrets ───────────────────────────────────────────────────────────────
step "4/7 fly secrets (single import = single restart)"
note "importing KEY=VALUE lines from $SECRETS_FILE (comments/blank/commented-optional lines stripped)"
if [ "$DRY_RUN" = "0" ]; then
  echo "  \$ grep -Ev '^\\s*(#|\$)' $SECRETS_FILE | fly secrets import -a $APP"
  grep -Ev '^\s*(#|$)' "$SECRETS_FILE" | fly secrets import -a "$APP"
else
  echo "  \$ grep -Ev '^\\s*(#|\$)' $SECRETS_FILE | fly secrets import -a $APP"
  echo "  (dry-run: not executed) — would set:"
  grep -Ev '^\s*(#|$)' "$SECRETS_FILE" | cut -d= -f1 | sed 's/^/      /'
fi

# ── 5 · deploy ────────────────────────────────────────────────────────────────
step "5/7 deploy (from $BACKEND_DIR — Dockerfile + fly.toml live there)"
GIT_SHA="$(git -C "$BACKEND_DIR" rev-parse --short HEAD 2>/dev/null || echo '')"
if [ -n "$GIT_SHA" ]; then
  note "stamping /version with GIT_SHA=$GIT_SHA"
  run fly deploy "$BACKEND_DIR" -a "$APP" --env "GIT_SHA=$GIT_SHA"
else
  run fly deploy "$BACKEND_DIR" -a "$APP"
fi

# ── 6 · smoke checks ──────────────────────────────────────────────────────────
step "6/7 post-deploy smoke ($BASE_URL)"
if [ "$DRY_RUN" = "0" ]; then
  sleep 5
  note "/health   → $(curl -sS -m 10 "$BASE_URL/health" || echo FAIL)"
  note "/version  → $(curl -sS -m 10 "$BASE_URL/version" || echo FAIL)"
  note "admin login page → HTTP $(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BASE_URL/app/admin-login.html" || echo FAIL) (want 200)"
  note "gate check: / should serve coming-soon → HTTP $(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BASE_URL/" || echo FAIL)"
  note "boot line (CLAUDE_MODE/storage/mock flags):"
  fly logs -a "$APP" --no-tail 2>/dev/null | grep -m1 'CLAUDE_MODE=' | sed 's/^/    /' || note "    (check manually: fly logs -a $APP)"
else
  note "would: curl $BASE_URL/health , $BASE_URL/version , $BASE_URL/app/admin-login.html"
  note "would: verify boot log line shows storage=r2 mock_media=true coming_soon=true"
fi

# ── 7 · what's left (operator-only) ──────────────────────────────────────────
step "7/7 remaining OPERATOR steps (this script cannot do these)"
cat <<EOF
  1. Google Cloud console → OAuth client → add redirect URI:
       $BASE_URL/auth/google/callback     (+ online-phantom.com one at cutover)
     and publish the consent screen (PLAN item 3).
  2. Stripe dashboard → Developers → Webhooks → add endpoint:
       $BASE_URL/webhook/stripe
     copy the whsec_... into secrets.prod.env and re-run step 4 (PLAN item 4).
  3. Log into $BASE_URL/app/admin-login.html and upload the audio library
     (PLAN item 6).
  4. Promote a locally-built tenant to verify end-to-end:
       node scripts/promote-tenant.js <slug> --to $BASE_URL --user ... --pass ...
  5. When ready to spend: fly.toml → CLAUDE_MODE=anthropic_api, MOCK_MEDIA_GEN=0
     → fly deploy. Spend stays opt-in until you flip these.
  6. Domain cutover: docs/runbooks/domain-cutover.md (PLAN item 8).
EOF

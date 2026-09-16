#!/usr/bin/env bash
#
# setup-web-tier.sh — run the Kryon Next.js app on the services VM behind a
# Cloudflare Tunnel, replacing the Vercel / Cloudflare Workers deployments.
#
# Run AFTER bootstrap.sh and migrate-from-micro.sh, on the A1.Flex box.
# Idempotent: safe to re-run for redeploys.
#
#   bash setup-web-tier.sh                 # build + (re)start the web tier
#   TUNNEL_ONLY=1 bash setup-web-tier.sh   # skip the build, just fix the tunnel
#
set -euo pipefail

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

APP_USER="${SUDO_USER:-$(id -un)}"
REPO_DIR="/home/${APP_USER}/kryon"
CLIENT_DIR="${REPO_DIR}/client"
DOMAIN="${DOMAIN:-kryonprotocol.live}"
TUNNEL_NAME="${TUNNEL_NAME:-kryon}"

[[ -d "$CLIENT_DIR" ]] || die "No repo at ${REPO_DIR}. Clone it first."

# ── 1. Preflight: the env must be able to reach BOTH databases ───────────────
# This is the whole reason the web tier moved here. If these are missing the
# site builds fine and then 503s on every API route, which is exactly the
# failure mode we are replacing — so fail loudly now instead.
log "Preflight: database configuration"

ENV_FILE="${CLIENT_DIR}/.env.local"
[[ -f "$ENV_FILE" ]] || die "Missing ${ENV_FILE}"

for var in DATABASE_URL_MAINNET DATABASE_URL_TESTNET; do
  if grep -qE "^${var}=." "$ENV_FILE"; then
    ok "${var} set"
  else
    die "${var} is not set in ${ENV_FILE}.
      The network toggle serves both venues from this one deployment, and
      lib/db.ts deliberately refuses to fall back to the other network's
      database — serving mainnet positions to a testnet caller would present
      real money as play money. Set both, pointing at localhost:5432."
  fi
done

# rateLimit() FAILS CLOSED in production: with no Upstash credentials it denies
# every request to /api/orders, /cancel, /settlements, /fills, /funding and
# /portfolio. /api/ready does not rate-limit, so the site would come up green
# and then reject every order — a confusing way to fail Phase 9.
for var in UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN; do
  grep -qE "^${var}=." "$ENV_FILE" \
    || die "${var} is not set in ${ENV_FILE}.
      lib/rate-limit.ts denies every state-mutating request when Upstash is
      unconfigured under NODE_ENV=production — orders, cancels, settlements,
      fills, funding and portfolio all return denied while /api/ready still
      reports ok. Set both before deploying."
done
ok "Upstash rate-limit credentials present"

for var in NEXT_PUBLIC_MAINNET_KEEPERS_LIVE NEXT_PUBLIC_TESTNET_KEEPERS_LIVE; do
  grep -qE "^${var}=." "$ENV_FILE" \
    || warn "${var} unset — the degraded-venue banner falls back to \"only the primary network is live\", which mislabels the other venue in whichever direction is wrong."
done

# ── 2. Build ─────────────────────────────────────────────────────────────────
# Built on the box, not shipped: NEXT_PUBLIC_* values are inlined into the
# client bundle by static textual substitution at build time, so a bundle built
# anywhere else carries that machine's env, not this one's.
if [[ -z "${TUNNEL_ONLY:-}" ]]; then
  log "Building the Next app"
  cd "$CLIENT_DIR"

  npm ci --no-audit --fund=false
  # Docs are a static Docusaurus export served from public/docs by a rewrite in
  # next.config.ts; without this step /docs/* 404s on the live site.
  if [[ -d "${REPO_DIR}/docs" ]]; then
    npm run docs:build || warn "docs build failed — /docs will 404, site otherwise fine"
  fi
  npm run build || die "next build failed — previous bundle left in place, site still serving"
  ok "build complete"
fi

# ── 3. cloudflared ───────────────────────────────────────────────────────────
log "Installing cloudflared"

if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH=$(uname -m); PKG_ARCH="arm64"
  [[ "$ARCH" == "x86_64" ]] && PKG_ARCH="amd64"
  curl -fsSL -o /tmp/cloudflared.rpm \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${PKG_ARCH}.rpm"
  sudo rpm -i /tmp/cloudflared.rpm
  ok "cloudflared installed ($(cloudflared --version))"
else
  ok "cloudflared already present ($(cloudflared --version))"
fi

if [[ ! -f /etc/cloudflared/cert.pem ]]; then
  warn "Not logged in to Cloudflare yet. Run these two commands yourself —"
  warn "  the first opens a browser URL you must approve in your account:"
  warn ""
  warn "    cloudflared tunnel login"
  warn "    cloudflared tunnel create ${TUNNEL_NAME}"
  warn ""
  warn "then copy cloudflared-config.yml to /etc/cloudflared/config.yml,"
  warn "substitute the tunnel id, and re-run with TUNNEL_ONLY=1."
  exit 0
fi

[[ -f /etc/cloudflared/config.yml ]] \
  || die "/etc/cloudflared/config.yml missing — copy cloudflared-config.yml there and set <TUNNEL-ID>."
grep -q '<TUNNEL-ID>' /etc/cloudflared/config.yml \
  && die "/etc/cloudflared/config.yml still contains the <TUNNEL-ID> placeholder."

sudo cloudflared --config /etc/cloudflared/config.yml validate \
  || die "tunnel config invalid"
ok "tunnel config valid"

# ── 4. DNS routes ────────────────────────────────────────────────────────────
# Idempotent: re-pointing an existing record is not an error.
log "Routing hostnames to the tunnel"
for host in "$DOMAIN" "www.${DOMAIN}" "ws.${DOMAIN}" "ws-testnet.${DOMAIN}"; do
  if cloudflared tunnel route dns "$TUNNEL_NAME" "$host" 2>&1 | tee /tmp/route.log | grep -qiE 'added|updated'; then
    ok "$host → tunnel"
  else
    grep -qi 'already' /tmp/route.log && ok "$host already routed" \
      || warn "$host: $(tail -1 /tmp/route.log)"
  fi
done

# ── 5. Services ──────────────────────────────────────────────────────────────
log "Starting web tier + tunnel"

sudo cloudflared service install 2>/dev/null || true
sudo systemctl enable --now cloudflared
ok "cloudflared: $(systemctl is-active cloudflared)"

cd "$CLIENT_DIR"
if pm2 describe kryon-web >/dev/null 2>&1; then
  pm2 restart kryon-web --update-env
else
  pm2 start ecosystem.web.config.cjs
fi
pm2 save
ok "kryon-web started"

# ── 6. Verify ────────────────────────────────────────────────────────────────
log "Verifying"
sleep 5

# The bind matters as much as the response. `next start` ignores the HOSTNAME
# env var (only the standalone server.js reads it), so a missing -H flag means
# the site is also served unencrypted on <public-ip>:3000, past the tunnel.
if ss -ltnp 2>/dev/null | grep -q '127.0.0.1:3000'; then
  ok "kryon-web bound to loopback only"
elif ss -ltn 2>/dev/null | grep -qE '(0\.0\.0\.0|\*):3000'; then
  warn "kryon-web is listening on ALL interfaces — check the -H flag in ecosystem.web.config.cjs"
fi

for net in mainnet testnet; do
  body=$(curl -fsS -m 15 "http://127.0.0.1:3000/api/ready?network=${net}" 2>/dev/null || echo '{}')
  if grep -q '"ok":true' <<<"$body"; then
    ok "local /api/ready?network=${net} → ok"
  else
    warn "local /api/ready?network=${net} → ${body}"
  fi
done

if curl -fsS -m 20 "https://${DOMAIN}/api/ready" | grep -q '"ok":true'; then
  ok "https://${DOMAIN}/api/ready → ok — the site is live through the tunnel"
else
  warn "public readiness not ok yet — DNS can take a minute to propagate after the first route"
fi

log "Done"
echo "  pm2 logs kryon-web            # app logs"
echo "  journalctl -u cloudflared -f  # tunnel logs"

#!/usr/bin/env bash
#
# ship-web-tier.sh — build the Next app HERE and ship it to the web-tier box.
#
#   bash ship-web-tier.sh                    # build + ship + restart
#   SKIP_BUILD=1 bash ship-web-tier.sh       # ship the existing .next/ only
#
# WHY THE BUILD IS NOT ON THE BOX
# -------------------------------
# The web tier runs on a 945MB E2.1.Micro. `next build` needs well over a
# gigabyte and would OOM (or thrash swap for an hour). `output: "standalone"`
# emits a self-contained server plus only the traced node_modules — roughly
# 50MB — so the compile happens on a developer machine and the box only serves.
#
# NEXT_PUBLIC_* values are inlined into the client bundle at build time by
# static textual substitution, so THIS script's environment is what ends up in
# the browser. That is why every NEXT_PUBLIC_ var is set explicitly below
# rather than inherited from whatever happens to be in the shell.
set -euo pipefail

WEB_HOST="${WEB_HOST:-130.210.27.190}"
WEB_USER="${WEB_USER:-opc}"
KEY="${KEY:-$HOME/.ssh/kryon-vm}"
REPO="${REPO:-$HOME/Downloads/Kryon}"
CLIENT="${REPO}/client"
# /opt, not /home: systemd cannot write under user_home_t, so the unit runs the
# app out of /opt/kryon-web. Shipping to ~/kryon-web deploys to a directory
# nothing serves, and starting it there raises a SECOND server on port 3000.
REMOTE="/opt/kryon-web"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

SSH=(ssh -i "$KEY" -o BatchMode=yes "${WEB_USER}@${WEB_HOST}")

# ── Build ────────────────────────────────────────────────────────────────────
if [[ -z "${SKIP_BUILD:-}" ]]; then
  log "Building (standalone)"
  cd "$CLIENT"
  [[ -f .env.production.local ]] \
    || die "missing ${CLIENT}/.env.production.local — it holds the NEXT_PUBLIC_* values
     that get inlined into the browser bundle. Copy .env.production.example and fill it in."
  # Docusaurus static export served from public/docs by a rewrite; without it
  # every /docs route 404s on the live site.
  [[ -d "${REPO}/docs" ]] && npm run docs:build >/dev/null 2>&1 || true
  npm run build || die "next build failed — nothing shipped, box still serving the old bundle"
  ok "build complete"
fi

[[ -d "${CLIENT}/.next/standalone" ]] \
  || die "no .next/standalone — is output:\"standalone\" still set in next.config.ts?"

# ── Assemble ─────────────────────────────────────────────────────────────────
# standalone omits static assets and public/ by design; both must be laid in.
log "Assembling the bundle"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
# mktemp -d makes the directory 0700, and `rsync -a` copies that mode onto
# ${REMOTE} itself — leaving /opt/kryon-web unreadable by the service user, so
# systemd restarts into "cannot open directory" while the still-running process
# keeps serving from open fds. Looks healthy, is not. Set the mode we want served.
chmod 755 "$STAGE"
cp -R "${CLIENT}/.next/standalone/." "${STAGE}/"
mkdir -p "${STAGE}/.next"
cp -R "${CLIENT}/.next/static" "${STAGE}/.next/static"
[[ -d "${CLIENT}/public" ]] && cp -R "${CLIENT}/public" "${STAGE}/public"
ok "$(du -sh "$STAGE" | cut -f1) staged"

# ── Ship ─────────────────────────────────────────────────────────────────────
log "Shipping to ${WEB_HOST}"
"${SSH[@]}" "sudo mkdir -p ${REMOTE}"

# Keep the previous bundle so a bad deploy is one `mv` away from rolled back.
# SKIP_BACKUP=1 when retrying a failed ship: the existing .prev is the last
# KNOWN-GOOD tree, and re-copying would overwrite it with the half-shipped one.
if [[ -z "${SKIP_BACKUP:-}" ]]; then
  "${SSH[@]}" "sudo rm -rf ${REMOTE}.prev && sudo cp -a ${REMOTE} ${REMOTE}.prev"
  ok "previous bundle saved to ${REMOTE}.prev"
else
  ok "SKIP_BACKUP=1 — keeping the existing ${REMOTE}.prev"
fi

# --delete so a removed route or asset does not linger and get served — but
# .env.local lives ONLY on the box (DATABASE_URL_*, UPSTASH_*, operator secrets)
# and is not in the staged bundle, so without this exclude --delete wipes it and
# the app comes back up with no database.
#
# --rsync-path="sudo rsync": /opt is root-owned and the existing tree carries the
# BUILD machine's uid (501:games, preserved by an earlier -a from macOS), so a
# plain rsync as ${WEB_USER} cannot write into it.
#
# The chown is a separate step rather than rsync's --chown because macOS ships
# rsync 2.6.9, which does not have that flag (it fails "unrecognized option").
# No -z: this box is 1/8 OCPU with ~60MB free, and gzip on both ends is enough
# to make sshd drop the connection mid-transfer (observed 2026-09-06). --partial
# keeps what did land so a retry resumes instead of restarting from zero.
rsync -a --partial --delete --exclude='.env.local' --exclude='.env.production.local' \
  --rsync-path="sudo rsync" \
  -e "ssh -i ${KEY} -o BatchMode=yes" \
  "${STAGE}/" "${WEB_USER}@${WEB_HOST}:${REMOTE}/"
"${SSH[@]}" "sudo chown -R ${WEB_USER}:${WEB_USER} ${REMOTE}"
ok "shipped"

# Server-only secrets live on the box and are NEVER in the shipped bundle.
"${SSH[@]}" "test -f ${REMOTE}/.env.local" \
  || die "${REMOTE}/.env.local is missing on the box — it holds DATABASE_URL_*,
     UPSTASH_* and the operator secrets. Create it there (chmod 600) before deploying."

# ── Restart ──────────────────────────────────────────────────────────────────
log "Restarting"
# systemd, not pm2 — pm2's daemon costs another ~40MB on a 945MB box, so the
# unit runs server.js directly. `restorecon` because rsync writes files with the
# default label and SELinux will not let init_t execute an unlabelled bundle.
"${SSH[@]}" "sudo restorecon -R ${REMOTE} 2>/dev/null; sudo systemctl restart kryon-web"
"${SSH[@]}" "systemctl is-active kryon-web" | grep -qx active \
  || die "kryon-web did not come back up — check 'journalctl -u kryon-web -n 50' on the box"
ok "kryon-web restarted (systemd)"

sleep 6
for net in mainnet testnet; do
  body=$("${SSH[@]}" "curl -fsS -m 15 'http://127.0.0.1:3000/api/ready?network=${net}'" 2>/dev/null || echo "")
  case "$body" in
    *'"ok":true'*) ok "local /api/ready?network=${net} → ok" ;;
    *) printf '\033[1;33m  ! %s: %s\033[0m\n' "$net" "${body:-no response}" ;;
  esac
done

#!/usr/bin/env bash
#
# seed-web-env.sh — build the web tier's .env.local by copying the database
# password straight from the database box, without ever printing it.
#
#   bash seed-web-env.sh
#
# The password exists in exactly one place: ~/kryon/client/.env.local on the
# database box, written during the 2026-08-22 Postgres migration. Reading it to
# a terminal puts a live production credential into scrollback and any transcript
# — which is precisely how the Cloudflare and Upstash tokens came to need
# rotating. This pipes it host-to-host instead.
set -euo pipefail

DB_HOST="${DB_HOST:-92.4.91.30}"
DB_PRIVATE="${DB_PRIVATE:-10.0.0.222}"
WEB_HOST="${WEB_HOST:-130.210.27.190}"
DB_KEY="${DB_KEY:-$HOME/.ssh/kryon-vm-oracle.key}"
WEB_KEY="${WEB_KEY:-$HOME/.ssh/kryon-vm}"
REMOTE="/home/opc/kryon-web"

ok()  { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v ssh >/dev/null || die "ssh not found"

# Extract ONLY the password field, on the remote host, and pass it through a
# pipe. It is never assigned to a local variable that could leak via `set -x`,
# never echoed, and never written to a local file.
PW=$(ssh -i "$DB_KEY" -o BatchMode=yes "opc@${DB_HOST}" \
  'grep -m1 "^DATABASE_URL=" ~/kryon/client/.env.local \
   | sed -E "s|^DATABASE_URL=\"?postgresql://[^:]+:([^@]+)@.*|\1|"') \
  || die "could not read the database URL from ${DB_HOST}"

[[ -n "$PW" && "$PW" != *"DATABASE_URL"* ]] \
  || die "could not parse the password out of DATABASE_URL on ${DB_HOST}"
ok "password read from ${DB_HOST} (not displayed)"

# Written with a quoted heredoc on the far side so the value never appears in
# an argv the process table would show.
ssh -i "$WEB_KEY" -o BatchMode=yes "opc@${WEB_HOST}" \
  "mkdir -p ${REMOTE} && cat > ${REMOTE}/.env.local.dbpart && chmod 600 ${REMOTE}/.env.local.dbpart" <<INNER
DATABASE_URL_MAINNET=postgresql://kryon:${PW}@${DB_PRIVATE}:5432/kryon_mainnet?sslmode=disable
DATABASE_URL_TESTNET=postgresql://kryon:${PW}@${DB_PRIVATE}:5432/kryon_testnet?sslmode=disable
INNER
unset PW
ok "database URLs written to ${WEB_HOST}:${REMOTE}/.env.local.dbpart (0600)"

echo
echo "Now verify the web box can actually reach the database:"
echo "  ssh -i ${WEB_KEY} opc@${WEB_HOST} '. ${REMOTE}/.env.local.dbpart && psql \"\$DATABASE_URL_MAINNET\" -c \"SELECT count(*) FROM \\\"Market\\\";\"'"

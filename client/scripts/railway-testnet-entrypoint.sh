#!/usr/bin/env bash
#
# Railway start command for the testnet keeper fleet.
# (pm2 is installed at build time, not fetched via npx at runtime.)
#
# ecosystem.testnet.config.cjs launches every keeper via
# `tsx --env-file=.env.testnet ...`, which needs a real file on disk — but
# Railway injects secrets as container environment variables, not a dotenv
# file. This materialises one from whatever of the expected keys Railway has
# actually set, then hands off to pm2-runtime (the foreground-friendly pm2
# variant meant for exactly this: one container, multiple managed processes,
# no daemon to babysit).
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS=(
  NEXT_PUBLIC_STELLAR_NETWORK NEXT_PUBLIC_STELLAR_RPC_URL
  NEXT_PUBLIC_STELLAR_PASSPHRASE NEXT_PUBLIC_STELLAR_HORIZON_URL
  NEXT_PUBLIC_ACTIVE_MARKETS DATABASE_URL DIRECT_URL
  NEXT_PUBLIC_CONTRACT_GOVERNANCE NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER
  NEXT_PUBLIC_CONTRACT_VAULT NEXT_PUBLIC_CONTRACT_ENGINE
  NEXT_PUBLIC_CONTRACT_ORDER_GATEWAY NEXT_PUBLIC_CONTRACT_INSURANCE
  NEXT_PUBLIC_CONTRACT_LIQUIDATION NEXT_PUBLIC_CONTRACT_RISK
  NEXT_PUBLIC_ASSET_NATIVE_XLM NEXT_PUBLIC_ASSET_USDC NEXT_PUBLIC_USDC_ISSUER
  ORACLE_PUBLISHER_SECRET MATCHER_OPERATOR_SECRET LIQUIDATOR_SECRET
  FUNDING_KEEPER_SECRET
  # The network-suffixed spellings the multi-network code also accepts. A key
  # set only under a suffixed name used to be dropped here silently, which for
  # the matcher meant starting with no settlement key at all — every match
  # rolled straight back and the venue recorded no trades.
  ORACLE_PUBLISHER_SECRET_TESTNET MATCHER_OPERATOR_SECRET_TESTNET LIQUIDATOR_SECRET_TESTNET
  PUBLISH_TIME_BACKDATE_SECS PUBLISH_STAGGER_MS ALERT_WEBHOOK_URL
  SETTLEMENT_JOB_MAX_AGE_MINUTES FUNDING_INTERVAL_MS FUNDING_STAGGER_MS
)

: > .env.testnet
for k in "${KEYS[@]}"; do
  v="${!k:-}"
  [[ -n "$v" ]] && printf '%s=%s\n' "$k" "$v" >> .env.testnet
done
chmod 600 .env.testnet

# Fail fast and loudly if the fleet has no settlement key for this network.
# pm2 would otherwise start all seven processes "successfully" and the matcher
# would quietly discard every fill it matched.
if [[ -z "${MATCHER_OPERATOR_SECRET_TESTNET:-}${MATCHER_OPERATOR_SECRET:-}" ]]; then
  echo "FATAL: neither MATCHER_OPERATOR_SECRET_TESTNET nor MATCHER_OPERATOR_SECRET is set;" >&2
  echo "       the matcher cannot settle and would roll back every trade." >&2
  exit 1
fi

exec npx --yes pm2-runtime ecosystem.testnet.config.cjs

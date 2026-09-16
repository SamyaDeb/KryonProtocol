#!/usr/bin/env bash
#
# list-usdt0-testnet.sh — list the mock USDT0 on the LIVE testnet vault
# (CCFVY4IS…, the one with user traction), so it appears in the deposit dialog
# on kryonprotocol.live's testnet toggle.
#
# Everything except the keys is filled in here, because getting any of it wrong
# is silent: a mismatched publisher makes every write_price Unauthorized, and a
# wrong asset id lists a token nobody holds.
#
#   VAULT_ADMIN_SECRET=S…  the GAPK4UCV… key (vault + oracle admin)
#   ORACLE_PUBLISHER_SECRET=S…  optional; seeds the first price so the listing
#                               does not wait on the keeper. Its public key must
#                               be GDCVRZJC… or write_price is rejected.
#
# Usage:
#   VAULT_ADMIN_SECRET=S… bash scripts/list-usdt0-testnet.sh --dry-run
#   VAULT_ADMIN_SECRET=S… ORACLE_PUBLISHER_SECRET=S… bash scripts/list-usdt0-testnet.sh
#
# AFTERWARDS, and this is not optional: set ORACLE_PUBLISH_USDT0=true on the
# testnet oracle-keeper and restart it. A collateral feed that goes stale makes
# account_health revert, freezing trades, withdrawals and liquidations for every
# account holding USDT0.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VAULT_ADMIN_SECRET:?set VAULT_ADMIN_SECRET — the vault/oracle admin key (GAPK4UCV…)}"
export ORACLE_ADMIN_SECRET="${ORACLE_ADMIN_SECRET:-$VAULT_ADMIN_SECRET}"

export NEXT_PUBLIC_STELLAR_NETWORK=testnet
# The mock issued by scripts/deploy-testnet-usdt0.ts. Real USDT0 is mainnet-only.
export NEXT_PUBLIC_ASSET_USDT0=CCXWM7LWNT4VDRUJ4KZILV6KB7SXWDWDBF5TT65E5IRDEX7QZTDMNLRO
export NEXT_PUBLIC_USDT0_ISSUER=GDEJSYQQOZIUKFZVS4OKWZCH7D3YCGN2NMUGBCNPVQXFX6XN4JRK32ND
# The publisher the testnet keeper signs with (infra/deploy/testnet-deployment-v2.json).
export ORACLE_PUBLISHER_PUBKEY="${ORACLE_PUBLISHER_PUBKEY:-GDCVRZJCHTXOP5L3YNPIXDP7IKVIRUVAT2KCF3R7O524DLNNOKDZZUF6}"
# Testnet: exercise the cap path without making it the binding constraint.
export USDT0_DEPOSIT_CAP="${USDT0_DEPOSIT_CAP:-1000000}"
export USDT0_HAIRCUT_BPS="${USDT0_HAIRCUT_BPS:-500}"

exec npx tsx scripts/list-usdt0.ts "$@"

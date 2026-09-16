#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${ROOT_DIR}/infra/budget/reports"
NETWORK="${STELLAR_NETWORK:-testnet}"
RPC_URL="${STELLAR_RPC_URL:-}"
NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-}"

mkdir -p "${OUT_DIR}"

if ! command -v stellar >/dev/null 2>&1; then
  echo "stellar CLI is required for Soroban budget simulation" >&2
  exit 1
fi

if [[ -z "${RPC_URL}" || -z "${NETWORK_PASSPHRASE}" ]]; then
  echo "Set STELLAR_RPC_URL and STELLAR_NETWORK_PASSPHRASE before simulation" >&2
  exit 1
fi

cat >"${OUT_DIR}/${NETWORK}-budget-checklist.md" <<EOF
# Soroban Budget Simulation Checklist

Network: ${NETWORK}

Run contract-specific simulations for:

- oracle adapter: set_feed, set_quorum_feed, write_price, write_quorum_price
- vault: deposit, withdraw, sync_positions
- engine: set_market, update_funding, open_position, increase_position, reduce_position, close_position, charge_trade_fee
- order gateway: settle_matched_fill, cancel_order
- liquidation: liquidate
- insurance: deposit, pay_liquidator, record_bad_debt
- governance: queue, execute, cancel, guardian_pause

For each call capture:

- CPU instructions
- memory bytes
- ledger reads/writes
- rent footprint
- returned events
- failure mode at configured limits

EOF

echo "Budget checklist written to ${OUT_DIR}/${NETWORK}-budget-checklist.md"
echo "Use stellar contract invoke --simulate for each deployed contract and append JSON output to ${OUT_DIR}."

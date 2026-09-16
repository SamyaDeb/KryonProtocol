#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${1:-${ROOT_DIR}/infra/deploy/manifest.example.toml}"

required_env=(
  STELLAR_NETWORK
  STELLAR_RPC_URL
  STELLAR_NETWORK_PASSPHRASE
  GOVERNANCE_ADMIN
  ORACLE_CONFIG_ADMIN
  ORDER_GATEWAY_ADDRESS
  LIQUIDATION_ADDRESS
)

for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
done

if ! command -v stellar >/dev/null 2>&1; then
  echo "stellar CLI is required for role transfer execution" >&2
  exit 1
fi

echo "Role transfer preflight"
echo "network=${STELLAR_NETWORK}"
echo "manifest=${MANIFEST}"
echo "governance_admin=${GOVERNANCE_ADMIN}"
echo "oracle_config_admin=${ORACLE_CONFIG_ADMIN}"
echo "order_gateway=${ORDER_GATEWAY_ADDRESS}"
echo "liquidation=${LIQUIDATION_ADDRESS}"

cat <<EOF

Execute role transfers in this order:

1. Configure engine order gateway by invoking `set_order_gateway(${ORDER_GATEWAY_ADDRESS})`.
2. Configure engine liquidation contract by invoking `set_liquidation(${LIQUIDATION_ADDRESS})`.
3. On every contract, invoke `nominate_admin(${GOVERNANCE_ADMIN})` from the current admin signer.
4. From the governance-controlled signer, invoke `accept_admin()` on every contract.
5. Re-run read-only checks that no deployer address keeps production authority.

Contract ids and signer profiles are environment-specific, so this script emits
the safe execution plan and validates environment. Wire the resulting calls into
your deployment runner after manifest addresses are finalized.
EOF

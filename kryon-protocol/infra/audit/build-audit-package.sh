#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${ROOT_DIR}/infra/audit/package"
REPORT="${OUT_DIR}/README.md"

mkdir -p "${OUT_DIR}"

{
  echo "# Krypton Redegined Perp Audit Package"
  echo
  echo "Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo
  echo "## Required Reviewer Inputs"
  echo
  echo "- Git commit under review"
  echo "- Contract WASM hashes"
  echo "- Deployed contract ids"
  echo "- Governance/admin addresses"
  echo "- Oracle publisher addresses"
  echo "- Soroban budget reports"
  echo "- Full test and clippy logs"
  echo
  echo "## Included Documents"
  echo
  echo "- docs/architecture.md"
  echo "- docs/security-model.md"
  echo "- docs/legacy-issues-fixed.md"
  echo "- infra/deploy/runbooks/mainnet-readiness.md"
  echo "- infra/budget/soroban-footprint-baseline.toml"
  echo "- prisma/schema.prisma"
  echo
  echo "## Commands Auditors Should Re-run"
  echo
  echo '```bash'
  echo "cargo fmt --all -- --check"
  echo "cargo clippy --workspace --all-targets -- -D warnings"
  echo "cargo test --workspace"
  echo "npm run db:generate"
  echo '```'
} >"${REPORT}"

cp "${ROOT_DIR}/README.md" "${OUT_DIR}/PROJECT-README.md"
cp "${ROOT_DIR}/docs/architecture.md" "${OUT_DIR}/architecture.md"
cp "${ROOT_DIR}/docs/security-model.md" "${OUT_DIR}/security-model.md"
cp "${ROOT_DIR}/docs/legacy-issues-fixed.md" "${OUT_DIR}/legacy-issues-fixed.md"
cp "${ROOT_DIR}/infra/deploy/runbooks/mainnet-readiness.md" "${OUT_DIR}/mainnet-readiness.md"
cp "${ROOT_DIR}/infra/budget/soroban-footprint-baseline.toml" "${OUT_DIR}/soroban-footprint-baseline.toml"
cp "${ROOT_DIR}/prisma/schema.prisma" "${OUT_DIR}/schema.prisma"

echo "Audit package written to ${OUT_DIR}"

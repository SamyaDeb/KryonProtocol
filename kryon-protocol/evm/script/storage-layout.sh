#!/usr/bin/env bash
# Snapshot storage layouts of every upgradeable contract into storage-layout/.
#
#   ./script/storage-layout.sh          # write snapshots
#   ./script/storage-layout.sh --check  # CI: fail if a layout changed
#
# State lives in ERC-7201 namespaces, which `forge inspect storageLayout`
# does not show, so each snapshot has two parts: the regular layout (must stay
# empty) and the field list of the namespaced struct (append-only between
# upgrades). A reorder, removal or type change of an existing field breaks
# every live proxy.
set -euo pipefail
cd "$(dirname "$0")/.."
FORGE="${FORGE:-arc-forge}"
OUT=storage-layout
mode="${1:-write}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# governance/KryonUpgradeable: the pause namespace every proxy inherits.
for path in Vault Engine OrderGateway OracleAdapter Liquidation Insurance RiskParams FeeRouter \
  governance/KryonUpgradeable; do
  c="$(basename "$path")"
  f="src/$path.sol"
  {
    echo "# $c"
    echo "## regular storage (must stay empty)"
    "$FORGE" inspect "$f:$c" storageLayout --json \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(s["slot"], s["offset"], s["label"], s["type"]) for s in d.get("storage", [])]'
    echo "## ERC-7201 namespace"
    grep -o 'erc7201:[a-zA-Z.]*' "$f" | head -1
    echo "## fields (append-only)"
    awk '/@custom:storage-location erc7201/{on=1; next} on && /struct .*Storage \{/{inside=1; next} inside && /^[[:space:]]*\}/{exit} inside' "$f" \
      | sed -E 's://.*$::; s/^[[:space:]]+//; s/[[:space:]]+$//' | grep -v '^$' | grep -v '^\*' || true
  } > "$tmp/$c.txt"
done

if [[ "$mode" == "--check" ]]; then
  diff -ru "$OUT" "$tmp" && echo "storage layouts unchanged"
else
  mkdir -p "$OUT"
  cp "$tmp"/*.txt "$OUT"/
  echo "wrote $(ls "$OUT" | wc -l | tr -d ' ') snapshots to $OUT/"
fi

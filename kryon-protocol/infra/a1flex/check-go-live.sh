#!/usr/bin/env bash
#
# check-go-live.sh — where is the go-live actually up to?
#
# Run from your LAPTOP, any time. Read-only: it creates nothing, changes
# nothing, and needs no credentials beyond an optional SSH key.
#
#   bash check-go-live.sh                 # phases that need no box
#   VM=<NEW_IP> bash check-go-live.sh     # also checks the new box over SSH
#
set -uo pipefail   # deliberately NOT -e: every check must run to completion

DOMAIN="${DOMAIN:-kryonprotocol.live}"
OLD_VM="${OLD_VM:-92.4.91.30}"
KEY="${KEY:-$HOME/.ssh/kryon-vm-oracle.key}"
VM="${VM:-}"

pass() { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$*"; BLOCKED+=("$*"); }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
BLOCKED=()

# ── Phase 1: operator wallets ────────────────────────────────────────────────
head_ "Phase 1 · operator wallets"
check_balance() {
  local name=$1 addr=$2
  local bal
  bal=$(curl -fsS -m 15 "https://horizon.stellar.org/accounts/${addr}" 2>/dev/null \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print([b["balance"] for b in d["balances"] if b["asset_type"]=="native"][0])' 2>/dev/null)
  if [[ -z "$bal" ]]; then warn "${name}: could not reach Horizon"; return; fi
  # 25 XLM is the monitor's own alert threshold; below it the fleet is days from
  # silence, and a keeper that dies mid-migration looks like a migration bug.
  if (( $(printf '%.0f' "$bal") >= 25 )); then pass "${name}: ${bal} XLM"
  else fail "${name}: ${bal} XLM — below the 25 XLM alert threshold"; fi
}
check_balance "oracle-publisher" GCGMZDM57KMBLBGFTNZVNVIW2BBCDS5UXR6LN6OGQ4SVBJ3QKPPER2WO
check_balance "matcher-operator" GCGPFN26NHKERBIEVOZN7SIFMB7T2TIWRMUQAQRWIOEKYPZL4D3O3AP3
check_balance "liquidator"       GA2GTULUA67G7AD5TVMGS3J5AXTQSREFQ43KZKZDIZNR7VCBMZEWKGON

# Liveness is a better signal than balance: a funded keeper that stopped
# publishing is the failure this project actually had for 43 days.
last=$(curl -fsS -m 15 "https://horizon.stellar.org/accounts/GCGMZDM57KMBLBGFTNZVNVIW2BBCDS5UXR6LN6OGQ4SVBJ3QKPPER2WO/transactions?order=desc&limit=1" 2>/dev/null \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["_embedded"]["records"];print(r[0]["created_at"] if r else "")' 2>/dev/null)
if [[ -n "$last" ]]; then
  # Computed in Python, not `date -j -f`: BSD date parses a trailing-Z timestamp
  # as LOCAL time, so an IST laptop reports a fresh publish as 330 minutes stale
  # — exactly the +05:30 offset. That false alarm is worse than no check.
  age=$(python3 -c '
import sys, datetime
t = datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()))' "$last")
  (( age < 900 )) && pass "oracle published $((age/60))m ${last}" \
                  || fail "oracle last published ${last} ($((age/60)) min ago) — keeper may be down"
fi

# ── Phase 2/3/4: the new box ─────────────────────────────────────────────────
head_ "Phase 2-4 · A1.Flex box"
if [[ -z "$VM" ]]; then
  fail "no VM set — the A1.Flex instance does not exist yet (run provision.sh), or pass VM=<ip>"
else
  if ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 "opc@$VM" true 2>/dev/null; then
    pass "ssh opc@$VM"
    arch=$(ssh -i "$KEY" -o BatchMode=yes "opc@$VM" 'uname -m; free -g | awk "/^Mem:/{print \$2}"' 2>/dev/null | tr '\n' ' ')
    pass "shape: $arch (want aarch64, ~23-24 GB)"
    online=$(ssh -i "$KEY" -o BatchMode=yes "opc@$VM" 'pm2 jlist 2>/dev/null | python3 -c "import sys,json;print(sum(1 for p in json.load(sys.stdin) if p[\"pm2_env\"][\"status\"]==\"online\"))"' 2>/dev/null)
    [[ "${online:-0}" -ge 7 ]] && pass "pm2: ${online} processes online" \
                               || fail "pm2: ${online:-0} online (want 7 mainnet, 14 with testnet)"
    ssh -i "$KEY" -o BatchMode=yes "opc@$VM" 'systemctl is-active --quiet cloudflared' 2>/dev/null \
      && pass "cloudflared running" || fail "cloudflared not running (Phase 7-8)"
  else
    fail "cannot ssh to opc@$VM"
  fi
fi

# ── Phase 5: DNS ─────────────────────────────────────────────────────────────
head_ "Phase 5 · DNS delegation"
# The registry is authoritative for the change; a public resolver may still be
# serving a cached answer for up to the SOA TTL (3600s on this zone).
reg=$(dig +norecurse NS "$DOMAIN" @v0n0.nic.live 2>/dev/null \
  | awk '/^'"$DOMAIN"'\./ && $4=="NS" {print $5}' | sort | tr '\n' ' ')
pub=$(dig +short NS "$DOMAIN" @1.1.1.1 2>/dev/null | sort | tr '\n' ' ')
if [[ "$reg" == *cloudflare* ]]; then
  pass "registry delegates to Cloudflare: $reg"
  [[ "$pub" == *cloudflare* ]] && pass "public resolvers agree" \
                               || warn "public resolvers still cached: $pub (wait out the 3600s TTL)"
else
  fail "registry still delegates to Name.com: $reg — Phase 5 Step D not done"
fi
for t in MX TXT DS; do
  r=$(dig +short $t "$DOMAIN" 2>/dev/null)
  [[ -z "$r" ]] && pass "no $t records (nothing to preserve)" || warn "$t present: $r"
done

# ── Phase 8/9: the public site ───────────────────────────────────────────────
head_ "Phase 8-9 · public site"
for net in mainnet testnet; do
  body=$(curl -fsSL -m 20 "https://${DOMAIN}/api/ready?network=${net}" 2>/dev/null)
  case "${body:-}" in
    *'"ok":true'*) pass "https://${DOMAIN}/api/ready?network=${net} → ok" ;;
    "")            fail "${net}: no response from https://${DOMAIN}" ;;
    *)             fail "${net}: ${body}" ;;
  esac
done

mk=$(curl -fsSL -m 20 "https://${DOMAIN}/api/markets/BTC-PERP" 2>/dev/null \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("markPrice",""),d.get("updatedAt",""))' 2>/dev/null)
[[ -n "$mk" ]] && pass "BTC-PERP: $mk" || warn "BTC-PERP not served yet"

# ── Phase 11: old tiers gone ─────────────────────────────────────────────────
head_ "Phase 11 · decommission"
for u in https://client-eight-mu-71.vercel.app https://kryon-client.kryon.workers.dev; do
  code=$(curl -sL -m 15 -o /dev/null -w '%{http_code}' "$u/api/ready" 2>/dev/null)
  [[ "$code" == "000" || "$code" == "404" ]] && pass "$u retired" \
    || warn "$u still answering ($code) — retire it once the VM serves"
done

# ── Verdict ──────────────────────────────────────────────────────────────────
head_ "Next action"
if (( ${#BLOCKED[@]} == 0 )); then
  printf '  \033[0;32mAll checks pass.\033[0m\n\n'
else
  printf '  %d blocking:\n' "${#BLOCKED[@]}"
  for b in "${BLOCKED[@]}"; do printf '    · %s\n' "$b"; done
  printf '\n  See GO-LIVE.md for the phase that owns the first one.\n\n'
fi

#!/usr/bin/env bash
#
# provision.sh — create the A1.Flex instance via the OCI CLI.
#
#   bash provision.sh                 # discover + create
#   DRY_RUN=1 bash provision.sh       # discover and print the plan only
#
# Prerequisite: an authenticated session —
#   ~/.oci-cli-venv/bin/oci session authenticate --region <region> --profile-name kryon
#
# Everything below is discovery-driven rather than hardcoded, because a
# tenancy's compartment/VCN/subnet OCIDs are unique per account and the
# free-tier Ampere image OCID changes with every Oracle Linux respin.
#
set -euo pipefail

OCI="${OCI_BIN:-$HOME/.oci-cli-venv/bin/oci}"
PROFILE="${OCI_PROFILE:-kryon}"
AUTH=(--profile "$PROFILE" --auth security_token)

DISPLAY_NAME="${DISPLAY_NAME:-kryon-services-a1}"
OCPUS="${OCPUS:-4}"
MEMORY_GB="${MEMORY_GB:-24}"
BOOT_GB="${BOOT_GB:-100}"
SHAPE="VM.Standard.A1.Flex"
SSH_PUB="${SSH_PUB:-$HOME/.ssh/kryon-vm.pub}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v "$OCI" >/dev/null || die "oci CLI not found at $OCI"
[[ -f "$SSH_PUB" ]] || die "ssh public key not found: $SSH_PUB"

# ── Identity ─────────────────────────────────────────────────────────────────
log "Identity"
# `oci session authenticate` writes tenancy and region into ~/.oci/config under
# the profile. Read them from there rather than calling an API that itself
# requires --tenancy-id (a chicken-and-egg the CLI does not resolve for you).
OCI_CONFIG="${OCI_CONFIG_FILE:-$HOME/.oci/config}"
[[ -f "$OCI_CONFIG" ]] || die "no OCI config at $OCI_CONFIG. Authenticate first:
     $OCI session authenticate --region <your-region> --profile-name $PROFILE"

read -r TENANCY REGION < <(python3 -c '
import configparser, sys
cfg = configparser.ConfigParser(); cfg.read(sys.argv[1])
prof = sys.argv[2]
if prof not in cfg: sys.exit("profile not found")
print(cfg[prof].get("tenancy",""), cfg[prof].get("region",""))
' "$OCI_CONFIG" "$PROFILE") || die "could not read profile [$PROFILE] from $OCI_CONFIG"

[[ -n "$TENANCY" ]] || die "no tenancy in profile [$PROFILE] — re-run session authenticate"
ok "tenancy $TENANCY"
ok "region   $REGION"

# Verify the session token is valid (and unexpired) BEFORE creating anything,
# so we never fail half-way through with resources already made.
"$OCI" "${AUTH[@]}" iam compartment list --compartment-id "$TENANCY" --limit 1 >/dev/null 2>&1 \
  || die "session token invalid or expired. Refresh:
     $OCI session refresh --profile $PROFILE
   or re-authenticate:
     $OCI session authenticate --region ${REGION:-<region>} --profile-name $PROFILE"
ok "session token valid"

# Always Free resources live in the root compartment on most free tenancies.
COMPARTMENT="${COMPARTMENT_OCID:-$TENANCY}"
ok "compartment $COMPARTMENT"

# ── Availability domains ─────────────────────────────────────────────────────
# Ampere capacity differs per AD; we try each in turn rather than failing on
# the first "Out of host capacity".
log "Availability domains"
# Read with a while-loop rather than `mapfile`: that is a bash 4 builtin and
# macOS still ships bash 3.2, where this script is most often run from.
ADS=()
while IFS= read -r ad; do
  [[ -n "$ad" ]] && ADS+=("$ad")
done < <("$OCI" "${AUTH[@]}" iam availability-domain list \
  --compartment-id "$COMPARTMENT" --query 'data[].name' --raw-output \
  | tr -d '[]", ' | grep -v '^$')
(( ${#ADS[@]} )) || die "no availability domains returned"
for ad in "${ADS[@]}"; do ok "$ad"; done

# ── Image: latest Oracle Linux 9, aarch64 ────────────────────────────────────
log "Image (Oracle Linux 9, aarch64)"
IMAGE=$("$OCI" "${AUTH[@]}" compute image list \
  --compartment-id "$COMPARTMENT" \
  --operating-system "Oracle Linux" \
  --operating-system-version "9" \
  --shape "$SHAPE" \
  --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output)
[[ -n "$IMAGE" && "$IMAGE" != "null" ]] || die "no Oracle Linux 9 aarch64 image found for $SHAPE"
IMAGE_NAME=$("$OCI" "${AUTH[@]}" compute image get --image-id "$IMAGE" \
  --query 'data."display-name"' --raw-output)
ok "$IMAGE_NAME"

# ── Network: reuse an existing VCN/subnet, else create ────────────────────────
log "Network"
SUBNET=$("$OCI" "${AUTH[@]}" network subnet list --compartment-id "$COMPARTMENT" \
  --query 'data[?"prohibit-public-ip-on-vnic"==`false`]|[0].id' --raw-output 2>/dev/null || echo "")

if [[ -n "$SUBNET" && "$SUBNET" != "null" ]]; then
  SUBNET_NAME=$("$OCI" "${AUTH[@]}" network subnet get --subnet-id "$SUBNET" \
    --query 'data."display-name"' --raw-output)
  VCN_ID=$("$OCI" "${AUTH[@]}" network subnet get --subnet-id "$SUBNET" \
    --query 'data."vcn-id"' --raw-output)
  ok "reusing public subnet: $SUBNET_NAME"
else
  warn "no public subnet found — creating a VCN with one"
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    ok "(dry run) would create VCN kryon-vcn 10.0.0.0/16 + public subnet"
    VCN_ID="<new>"; SUBNET="<new>"
  else
    VCN_ID=$("$OCI" "${AUTH[@]}" network vcn create --compartment-id "$COMPARTMENT" \
      --display-name kryon-vcn --cidr-blocks '["10.0.0.0/16"]' \
      --wait-for-state AVAILABLE --query 'data.id' --raw-output)
    IG=$("$OCI" "${AUTH[@]}" network internet-gateway create --compartment-id "$COMPARTMENT" \
      --vcn-id "$VCN_ID" --is-enabled true --display-name kryon-igw \
      --wait-for-state AVAILABLE --query 'data.id' --raw-output)
    RT=$("$OCI" "${AUTH[@]}" network vcn get --vcn-id "$VCN_ID" \
      --query 'data."default-route-table-id"' --raw-output)
    "$OCI" "${AUTH[@]}" network route-table update --rt-id "$RT" --force \
      --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IG\"}]" >/dev/null
    SUBNET=$("$OCI" "${AUTH[@]}" network subnet create --compartment-id "$COMPARTMENT" \
      --vcn-id "$VCN_ID" --cidr-block 10.0.1.0/24 --display-name kryon-public \
      --prohibit-public-ip-on-vnic false \
      --wait-for-state AVAILABLE --query 'data.id' --raw-output)
    ok "created VCN + public subnet"
  fi
fi

# ── Security list: the ws-server ports ───────────────────────────────────────
# SKIPPED BY DEFAULT, and that is the correct posture now.
#
# This layer was the one missed in July: firewalld was open on the host but the
# VCN never allowed 8080 in, so the ws-server was unreachable and the UI fell
# back to REST polling. The fix then would have been to open it.
#
# The web tier now runs on this box behind a Cloudflare Tunnel, and cloudflared
# reaches the ws-server over localhost. Opening 8080/8081 to 0.0.0.0/0 would
# publish the feed a second time, in the clear as ws:// rather than wss://,
# outside the tunnel's TLS and with no way to revoke it short of editing the
# security list again. Nothing needs it.
#
# Set WS_INGRESS=1 only if you deliberately want a direct, unencrypted feed —
# for a load test against the box, say — and remove the rules afterwards.
log "Security list ingress (8080/8081 ws)"
if [[ "${WS_INGRESS:-0}" != "1" ]]; then
  ok "skipped — cloudflared reaches the ws-server over localhost (WS_INGRESS=1 to override)"
elif [[ "${DRY_RUN:-0}" == "1" || "$SUBNET" == "<new>" ]]; then
  ok "(dry run) would add TCP 8080 + 8081 ingress from 0.0.0.0/0"
else
  SL=$("$OCI" "${AUTH[@]}" network vcn get --vcn-id "$VCN_ID" \
    --query 'data."default-security-list-id"' --raw-output)
  EXISTING=$("$OCI" "${AUTH[@]}" network security-list get --security-list-id "$SL" \
    --query 'data."ingress-security-rules"' --raw-output)
  ADDED=$(python3 - "$EXISTING" <<'PY'
import json, sys
rules = json.loads(sys.argv[1]) if sys.argv[1] not in ("", "null") else []
def has(port):
    for r in rules:
        tcp = r.get("tcp-options") or {}
        dst = tcp.get("destination-port-range") or {}
        if r.get("protocol") == "6" and dst.get("min") == port and dst.get("max") == port:
            return True
    return False
for port in (8080, 8081):
    if not has(port):
        rules.append({
            "protocol": "6", "source": "0.0.0.0/0", "source-type": "CIDR_BLOCK",
            "is-stateless": False,
            "tcp-options": {"destination-port-range": {"min": port, "max": port}},
            "description": f"Kryon ws-server ({'mainnet' if port==8080 else 'testnet'})",
        })
print(json.dumps(rules))
PY
)
  "$OCI" "${AUTH[@]}" network security-list update --security-list-id "$SL" --force \
    --ingress-security-rules "$ADDED" >/dev/null
  ok "ingress rules ensured on default security list"
fi

# ── Launch ───────────────────────────────────────────────────────────────────
log "Launching $SHAPE ($OCPUS OCPU / ${MEMORY_GB}GB / ${BOOT_GB}GB boot)"
cat <<PLAN
  name    : $DISPLAY_NAME
  shape   : $SHAPE  ${OCPUS} OCPU / ${MEMORY_GB} GB
  image   : $IMAGE_NAME
  subnet  : $SUBNET
  ssh key : $SSH_PUB

  Always Free budget check:
    ${OCPUS} OCPU x 730h = $(( OCPUS * 730 )) of 3,000 OCPU-hours
    ${MEMORY_GB} GB  x 730h = $(( MEMORY_GB * 730 )) of 18,000 GB-hours
PLAN

if (( OCPUS * 730 > 3000 )) || (( MEMORY_GB * 730 > 18000 )); then
  die "requested shape EXCEEDS the Always Free allowance — this would be billed. Aborting."
fi
ok "within Always Free allowance"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  warn "DRY_RUN=1 — nothing was created."
  exit 0
fi

INSTANCE_ID=""
for ad in "${ADS[@]}"; do
  echo "  trying $ad ..."
  set +e
  OUT=$("$OCI" "${AUTH[@]}" compute instance launch \
    --compartment-id "$COMPARTMENT" \
    --availability-domain "$ad" \
    --display-name "$DISPLAY_NAME" \
    --shape "$SHAPE" \
    --shape-config "{\"ocpus\":${OCPUS},\"memoryInGBs\":${MEMORY_GB}}" \
    --image-id "$IMAGE" \
    --subnet-id "$SUBNET" \
    --boot-volume-size-in-gbs "$BOOT_GB" \
    --assign-public-ip true \
    --ssh-authorized-keys-file "$SSH_PUB" \
    --wait-for-state RUNNING 2>&1)
  RC=$?
  set -e
  if (( RC == 0 )); then
    INSTANCE_ID=$(echo "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])' 2>/dev/null || echo "")
    ok "launched in $ad"
    break
  fi
  if echo "$OUT" | grep -qi "out of host capacity\|OutOfCapacity"; then
    warn "no Ampere capacity in $ad — trying next"
    continue
  fi
  echo "$OUT" | tail -5
  die "launch failed in $ad (see error above)"
done

[[ -n "$INSTANCE_ID" ]] || die "Out of host capacity in every availability domain.
     This is Oracle's free-tier Ampere shortage, not a config error. Options:
       - retry later (capacity frees up irregularly)
       - upgrade the tenancy to Pay As You Go for capacity priority
         (Always Free resources remain free under PAYG)"

log "Public IP"
IP=$("$OCI" "${AUTH[@]}" compute instance list-vnics --instance-id "$INSTANCE_ID" \
  --query 'data[0]."public-ip"' --raw-output)
ok "$IP"

cat <<DONE

────────────────────────────────────────────────────────────────
  Instance running.

    id : $INSTANCE_ID
    ip : $IP

  Next:
    scp -i ~/.ssh/kryon-vm-oracle.key bootstrap.sh opc@${IP}:~/
    ssh -i ~/.ssh/kryon-vm-oracle.key opc@${IP} 'bash ~/bootstrap.sh'
────────────────────────────────────────────────────────────────
DONE

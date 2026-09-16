#!/usr/bin/env bash
#
# migrate-from-micro.sh — move the mainnet database from the old E2.1.Micro
# box onto this A1.Flex host.
#
#   bash migrate-from-micro.sh <OLD_HOST_IP>   # e.g. 92.4.91.30
#
# Run this ON THE NEW BOX, after bootstrap.sh.
#
# ── The ordering is the whole point ──────────────────────────────────────────
# This stops the old fleet BEFORE dumping, and refuses to proceed if it cannot.
# Two independent reasons, both of which have bitten this project:
#
#  1. A dump taken while the indexer and matcher are writing captures a torn
#     state — Fill rows without their TxJob, positions mid-settlement.
#  2. Worse, if both boxes ever run the same network's keepers simultaneously,
#     two processes sign with the SAME Stellar keys and race one account's
#     sequence number. Both fleets then fail with TxBadSeq. That is exactly why
#     the laptop fleet had to be deleted in July.
#
set -euo pipefail

OLD_HOST="${1:-}"
OLD_USER="${OLD_USER:-opc}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/kryon-vm-oracle.key}"
DB="${DB:-kryon_mainnet}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "$OLD_HOST" ]] || die "usage: bash migrate-from-micro.sh <OLD_HOST_IP>"
[[ -f "$SSH_KEY" ]]  || die "ssh key not found: $SSH_KEY (set SSH_KEY=...)"

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new ${OLD_USER}@${OLD_HOST}"

log "Checking connectivity to old box"
$SSH 'echo ok' >/dev/null || die "cannot ssh to ${OLD_USER}@${OLD_HOST}"
ok "reachable"

log "Stopping the mainnet keeper fleet on the old box"
if [[ "${FORCE_STOPPED:-0}" == "1" ]]; then
  ok "FORCE_STOPPED=1 — trusting the operator that the old fleet is down"
fi
# Stop only the mainnet fleet; a testnet fleet there (if any) is harmless.
$SSH 'pm2 stop all >/dev/null 2>&1 || true; pm2 list' || true
# Count still-online processes. jq is the clean way, but the old micro box may
# not have it — fall back to counting "online" in pm2's table output. Both
# paths fail CLOSED: an unreadable status refuses the dump rather than risking
# a torn snapshot or a TxBadSeq collision.
if [[ "${FORCE_STOPPED:-0}" == "1" ]]; then RUNNING=0; else
RUNNING=$($SSH 'if command -v jq >/dev/null 2>&1; then
                  pm2 jlist 2>/dev/null | jq "[.[] | select(.pm2_env.status==\"online\")] | length"
                else
                  pm2 list 2>/dev/null | grep -c online
                fi' 2>/dev/null | tr -d "[:space:]" || echo "")
fi

if [[ -z "$RUNNING" || ! "$RUNNING" =~ ^[0-9]+$ ]]; then
  die "could not read pm2 status on the old box (got: '${RUNNING:-<empty>}').
     Refusing to dump a possibly-live database. Verify manually:
       ssh ${OLD_USER}@${OLD_HOST} 'pm2 list'   # expect every process stopped
     then re-run with FORCE_STOPPED=1 if you have confirmed it."
fi
if [[ "$RUNNING" != "0" ]]; then
  die "old box still reports ${RUNNING} online process(es). Refusing to dump a live database.
     Stop them manually:  ssh ${OLD_USER}@${OLD_HOST} 'pm2 stop all'"
fi
ok "old fleet stopped (0 online)"

log "Dumping ${DB} on the old box"
STAMP=$(date -u +%Y%m%d-%H%M%S)
REMOTE_DUMP="/tmp/${DB}-${STAMP}.dump"
$SSH "sudo -u postgres pg_dump -Fc ${DB} > ${REMOTE_DUMP} && ls -lh ${REMOTE_DUMP}" \
  || die "pg_dump failed on the old box"
ok "dump created"

log "Transferring"
scp -i "$SSH_KEY" "${OLD_USER}@${OLD_HOST}:${REMOTE_DUMP}" "/tmp/" >/dev/null
LOCAL_DUMP="/tmp/$(basename "$REMOTE_DUMP")"
[[ -s "$LOCAL_DUMP" ]] || die "transferred dump is empty"
ok "$(du -h "$LOCAL_DUMP" | cut -f1) received → ${LOCAL_DUMP}"

log "Restoring into local ${DB}"
# --clean --if-exists so a re-run replaces rather than duplicating. The target
# was created empty by bootstrap.sh, so on a first run these are no-ops.
sudo -u postgres pg_restore --clean --if-exists --no-owner --role=kryon \
     -d "${DB}" "${LOCAL_DUMP}" 2>&1 | grep -vi 'does not exist, skipping' || true
ok "restore complete"

log "Verifying row counts (old vs new)"
printf '  %-22s %12s %12s\n' TABLE OLD NEW
DRIFT=0
for tbl in Fill Order Position Market TxJob TraderStat; do
  OLD_N=$($SSH "sudo -u postgres psql -tAc 'SELECT count(*) FROM \"${tbl}\"' ${DB}" 2>/dev/null || echo "?")
  NEW_N=$(sudo -u postgres psql -tAc "SELECT count(*) FROM \"${tbl}\"" "${DB}" 2>/dev/null || echo "?")
  MARK=""
  # An unreadable count on either side is a failure, not a match. Without this,
  # a wrong table name makes both sides "?" — equal — and the script reports
  # "all verified" having verified nothing.
  if [[ "$OLD_N" == "?" || "$NEW_N" == "?" ]]; then
    MARK="  ← UNREADABLE"; DRIFT=1
  elif [[ "$OLD_N" != "$NEW_N" ]]; then
    MARK="  ← MISMATCH"; DRIFT=1
  fi
  printf '  %-22s %12s %12s%s\n' "$tbl" "$OLD_N" "$NEW_N" "$MARK"
done

if (( DRIFT )); then
  die "row counts differ or could not be read — do NOT terminate the old instance."
fi
ok "all verified table counts match"

cat <<SUMMARY

────────────────────────────────────────────────────────────────
  Migration complete. The old box's fleet is STOPPED — mainnet is
  currently DOWN until you start the fleet here.

  Next, on this box:
    1. client/.env.local → DATABASE_URL_MAINNET=...@127.0.0.1:5432/kryon_mainnet
    2. pm2 start ecosystem.config.cjs && pm2 save
    3. Confirm: pm2 logs kryon-oracle   (fresh publish tx hashes)
    4. Point NEXT_PUBLIC_WS_URL_MAINNET at this host, redeploy the client.

  Keep the old instance for at least a few days. Terminate only after
  the cutover checklist in README.md is fully green.
────────────────────────────────────────────────────────────────
SUMMARY

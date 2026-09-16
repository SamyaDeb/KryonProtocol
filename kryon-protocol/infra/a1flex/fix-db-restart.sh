#!/usr/bin/env bash
#
# fix-db-restart.sh — recover Postgres after `sed -i` relabelled its config.
# RUN ON THE DATABASE BOX.
#
# Ownership was already postgres:postgres and `sudo -u postgres postgres -C ...`
# parsed the file fine — yet systemd still could not start the server. That gap
# is the tell: systemd runs postgres in the confined SELinux domain
# postgresql_t, while `sudo -u postgres` runs unconfined. `sed -i` writes a new
# file, and the new inode gets a fresh SELinux label that may not match what
# postgresql_t is allowed to read.
set -uo pipefail
PGDATA=/var/lib/pgsql/data
ok()   { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '\033[1;36m== %s\033[0m\n' "$*"; }

info "SELinux mode"
getenforce 2>/dev/null || echo "  (selinux tools absent)"

info "Context on the config vs a file that was never edited"
ls -Z "${PGDATA}/postgresql.conf" "${PGDATA}/pg_hba.conf" "${PGDATA}/PG_VERSION" 2>/dev/null

info "Recent SELinux denials mentioning postgres"
sudo ausearch -m AVC -ts recent 2>/dev/null | grep -i postgres | tail -10 \
  || sudo journalctl -t setroubleshoot -n 10 --no-pager 2>/dev/null \
  || echo "  (no audit tooling / no denials found)"

info "Relabelling to the policy default"
sudo restorecon -Fv "${PGDATA}/postgresql.conf" "${PGDATA}/pg_hba.conf" 2>&1 | sed 's/^/  /' \
  || echo "  restorecon unavailable"
ls -Z "${PGDATA}/postgresql.conf" 2>/dev/null | sed 's/^/  now: /'

info "Restarting"
sudo systemctl restart postgresql
sleep 3
STATE=$(sudo systemctl is-active postgresql)
echo "  status: ${STATE}"

if [[ "$STATE" != "active" ]]; then
  info "Still failing — last 12 log lines"
  sudo journalctl -xeu postgresql.service --no-pager -n 12 2>/dev/null | grep -vE "^░|^--" | tail -8
  exit 1
fi

ok "postgres running"
info "Listening sockets"
sudo ss -ltn | grep 5432 | sed 's/^/  /'
info "Data intact"
sudo -u postgres psql -tAc 'SELECT count(*) FROM "Market"' kryon_mainnet 2>/dev/null | sed 's/^/  mainnet Market rows: /'
sudo -u postgres psql -tAc 'SELECT count(*) FROM "Fill"'   kryon_mainnet 2>/dev/null | sed 's/^/  mainnet Fill rows:   /'

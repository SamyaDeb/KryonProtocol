#!/usr/bin/env bash
#
# set-db-listen.sh — make Postgres listen on the private VNIC, via ALTER SYSTEM.
# RUN ON THE DATABASE BOX.
#
# WHY ALTER SYSTEM RATHER THAN EDITING postgresql.conf
# ----------------------------------------------------
# Editing the file has failed twice, in two different ways:
#   1. `sed -i` creates a new inode whose SELinux label postgresql_t cannot
#      read → "could not open configuration file: Permission denied", with the
#      contents perfectly valid and ownership already postgres:postgres.
#   2. Even once readable, the setting had no effect: the 2026-08-22 tuning
#      include (conf.d) sets listen_addresses again, and PostgreSQL honours the
#      LAST occurrence, so the edit at line 60 was silently overridden.
#
# ALTER SYSTEM writes postgresql.auto.conf, which is read last and therefore
# beats every include — and Postgres writes it itself, so ownership, mode and
# SELinux label are correct by construction. Both failure modes disappear.
set -euo pipefail
DB_PRIVATE_IP="${DB_PRIVATE_IP:-10.0.0.222}"
ok()  { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

echo "=== every listen_addresses currently in effect ==="
sudo -u postgres psql -tAc "SELECT name || ' = ' || setting || '  (from ' || COALESCE(sourcefile,'default') || ')' FROM pg_settings WHERE name='listen_addresses'"

sudo -u postgres psql -c "ALTER SYSTEM SET listen_addresses = 'localhost,${DB_PRIVATE_IP}'" >/dev/null
ok "ALTER SYSTEM applied (postgresql.auto.conf)"

sudo systemctl restart postgresql
sleep 3
sudo systemctl is-active postgresql | sed 's/^/  status: /'

if sudo ss -ltn | grep -q "${DB_PRIVATE_IP}:5432"; then
  ok "listening on ${DB_PRIVATE_IP}:5432"
else
  echo "  sockets:"; sudo ss -ltn | grep 5432 | sed 's/^/    /'
  die "still not listening on the private IP"
fi
sudo ss -ltn | grep -qE "0\.0\.0\.0:5432|\*:5432" \
  && die "bound to ALL interfaces — this box has a public IP" \
  || ok "not bound to 0.0.0.0"

echo "=== final sockets ==="
sudo ss -ltn | grep 5432 | sed 's/^/  /'

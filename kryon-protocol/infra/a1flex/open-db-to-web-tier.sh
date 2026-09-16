#!/usr/bin/env bash
#
# open-db-to-web-tier.sh — let the web-tier box reach Postgres over the VCN
# private network. RUN THIS ON THE DATABASE BOX (92.4.91.30).
#
#   ssh -i ~/.ssh/kryon-vm-oracle.key opc@92.4.91.30 'bash -s' < open-db-to-web-tier.sh
#
# The web tier could not be co-located with Postgres after all: the only free
# capacity was a second 1 GB micro, not the A1.Flex box. So the loopback-only
# posture becomes subnet-only instead — a narrower change than it sounds, since
# nothing outside this VCN can route to 10.0.0.0/24.
set -euo pipefail

DB_PRIVATE_IP="${DB_PRIVATE_IP:-10.0.0.222}"   # this box
WEB_PRIVATE_IP="${WEB_PRIVATE_IP:-10.0.0.130}" # kryon-web
SUBNET="${SUBNET:-10.0.0.0/24}"

ok() { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }

PGDATA=$(sudo -u postgres psql -tAc "SHOW data_directory")
ok "PGDATA=${PGDATA}"

# Bind loopback + the private VNIC. NOT 0.0.0.0: this box holds a public IP,
# and binding every interface would put Postgres on the internet with only the
# security list in front of it.
#
# Edited AS THE postgres USER, not with `sudo sed -i`. sed -i does not edit in
# place — it writes a temp file and renames it over the target, producing a new
# inode owned by root:root. Postgres then cannot read its own config and dies
# with "could not open configuration file: Permission denied" while the file
# contents are perfectly valid. That took the database down once already.
sudo cp -p "${PGDATA}/postgresql.conf" "${PGDATA}/postgresql.conf.bak.$(date -u +%Y%m%d%H%M%S)"
sudo -u postgres sed -i "s|^[#[:space:]]*listen_addresses.*|listen_addresses = 'localhost,${DB_PRIVATE_IP}'|" \
  "${PGDATA}/postgresql.conf"
sudo grep -q "^listen_addresses" "${PGDATA}/postgresql.conf" \
  || echo "listen_addresses = 'localhost,${DB_PRIVATE_IP}'" | sudo -u postgres tee -a "${PGDATA}/postgresql.conf" >/dev/null

# Belt and braces: however the edit took, the file must end up postgres-owned
# AND correctly labelled. The label is the part that bit us: sed -i creates a
# new inode, the new inode gets a label the postgresql_t domain cannot read,
# and Postgres refuses to start with
#   could not open configuration file "postgresql.conf": Permission denied
# while `ls -l` shows postgres:postgres and the contents are perfectly valid.
# restorecon puts the policy's own label back.
sudo chown postgres:postgres "${PGDATA}/postgresql.conf"
sudo chmod 600 "${PGDATA}/postgresql.conf"
sudo restorecon -F "${PGDATA}/postgresql.conf" 2>/dev/null || true
ok "$(sudo grep '^listen_addresses' "${PGDATA}/postgresql.conf")"

# A single host, not the subnet range: only the web tier needs in, and a /32
# means a future instance on this subnet does not silently inherit access.
if ! sudo grep -q "${WEB_PRIVATE_IP}/32" "${PGDATA}/pg_hba.conf"; then
  echo "host    all             kryon           ${WEB_PRIVATE_IP}/32          scram-sha-256" \
    | sudo -u postgres tee -a "${PGDATA}/pg_hba.conf" >/dev/null
  sudo chown postgres:postgres "${PGDATA}/pg_hba.conf"
  sudo restorecon -F "${PGDATA}/pg_hba.conf" 2>/dev/null || true
  ok "pg_hba: kryon@${WEB_PRIVATE_IP}/32 scram-sha-256"
else
  ok "pg_hba: ${WEB_PRIVATE_IP}/32 already present"
fi

if systemctl is-active --quiet firewalld; then
  sudo firewall-cmd --permanent \
    --add-rich-rule="rule family=ipv4 source address=${SUBNET} port port=5432 protocol=tcp accept" >/dev/null
  sudo firewall-cmd --reload >/dev/null
  ok "firewalld: 5432 from ${SUBNET} only"
fi

# RESTART, not reload. listen_addresses is a postmaster-level setting: a reload
# re-reads pg_hba.conf but leaves the listening sockets exactly as they were, so
# the bind silently stays loopback-only and the web tier gets "connection
# refused" against a config file that looks correct.
#
# The keepers hold pooled connections and will drop briefly. They reconnect on
# their own — `pg` reconnects per query through the shim — but expect a few
# error lines in pm2 logs around the restart.
# Validate the config BEFORE restarting a live database. Without this the first
# sign of a bad edit is an outage, which is how this script took mainnet down.
sudo -u postgres /usr/bin/postgres -C listen_addresses -D "$PGDATA" >/dev/null 2>&1 \
  || die "postgresql.conf is not readable/parseable by the postgres user — NOT restarting.
     The database is still up. Check ownership: it must be postgres:postgres."
ok "config validated as the postgres user"

sudo systemctl restart postgresql-16 2>/dev/null || sudo systemctl restart postgresql
ok "postgres restarted (listen_addresses needs a restart, not a reload)"

# Prove the socket actually moved rather than trusting the config file.
sleep 2
if sudo ss -ltn | grep -q "${DB_PRIVATE_IP}:5432"; then
  ok "listening on ${DB_PRIVATE_IP}:5432"
else
  printf '\033[1;31m  ✗ still not listening on %s:5432 — check postgresql.conf\033[0m\n' "$DB_PRIVATE_IP"
  sudo ss -ltn | grep 5432 || true
  exit 1
fi
if sudo ss -ltn | grep -qE "0\.0\.0\.0:5432|\*:5432"; then
  printf '\033[1;31m  ✗ bound to ALL interfaces — this box has a public IP. Fix listen_addresses.\033[0m\n'
  exit 1
fi
ok "not bound to 0.0.0.0"


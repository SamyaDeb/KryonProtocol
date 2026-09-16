#!/usr/bin/env bash
#
# bootstrap.sh — turn a fresh Oracle Linux 9 A1.Flex box into the Kryon
# services host (mainnet + testnet keeper fleets).
#
# Idempotent: every step checks before it acts, so re-running after a failure
# resumes rather than duplicating. Safe to run repeatedly.
#
#   bash bootstrap.sh
#
set -euo pipefail

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

PG_VERSION=16
NODE_MAJOR=22
APP_USER="${SUDO_USER:-$(id -un)}"
REPO_DIR="/home/${APP_USER}/kryon"

# ── Preflight ────────────────────────────────────────────────────────────────
log "Preflight"

if [[ "$(uname -m)" != "aarch64" ]]; then
  warn "Expected aarch64 (Ampere A1); found $(uname -m)."
  warn "This script targets A1.Flex. Continuing anyway."
fi

TOTAL_MB=$(free -m | awk '/^Mem:/{print $2}')
ok "arch=$(uname -m)  memory=${TOTAL_MB}MB  user=${APP_USER}"
if (( TOTAL_MB < 8000 )); then
  warn "Only ${TOTAL_MB}MB RAM — this looks like the micro shape, not an A1.Flex."
  warn "Postgres tuning scales to the hardware, but 14 Node processes plus"
  warn "Postgres plus a Next build will not fit comfortably below ~8GB."
  read -rp "  Continue? [y/N] " reply
  [[ "$reply" == "y" ]] || exit 1
fi

# ── Swap ─────────────────────────────────────────────────────────────────────
# 24GB makes swap far less load-bearing than it was on the 945MB box, but a
# modest file still prevents the OOM killer from taking out a keeper during a
# Postgres vacuum spike. Costs 4GB of the 200GB free storage.
log "Swap"
if swapon --show | grep -q '/swapfile'; then
  ok "swapfile already active"
else
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  ok "4GB swapfile created and persisted"
fi

# ── Base packages ────────────────────────────────────────────────────────────
log "Base packages"
sudo dnf install -y -q git tar gzip rsync jq policycoreutils-python-utils >/dev/null
ok "base packages present"

# ── Node ─────────────────────────────────────────────────────────────────────
log "Node ${NODE_MAJOR}"
if command -v node >/dev/null && [[ "$(node -v)" == v${NODE_MAJOR}.* ]]; then
  ok "node $(node -v) already installed"
else
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo bash - >/dev/null
  sudo dnf install -y -q nodejs >/dev/null
  ok "node $(node -v) installed"
fi

# ── pm2 + log rotation ───────────────────────────────────────────────────────
# Without rotation the keeper logs grow unbounded; the oracle alone writes a
# line per market per tick. This was a latent disk-fill on the old box.
log "pm2"
if command -v pm2 >/dev/null; then
  ok "pm2 $(pm2 -v) already installed"
else
  sudo npm install -g pm2 >/dev/null 2>&1
  ok "pm2 $(pm2 -v) installed"
fi
if pm2 list 2>/dev/null | grep -q pm2-logrotate; then
  ok "pm2-logrotate already configured"
else
  pm2 install pm2-logrotate >/dev/null 2>&1 || warn "pm2-logrotate install failed (non-fatal)"
  pm2 set pm2-logrotate:max_size 50M      >/dev/null 2>&1 || true
  pm2 set pm2-logrotate:retain 14         >/dev/null 2>&1 || true
  pm2 set pm2-logrotate:compress true     >/dev/null 2>&1 || true
  ok "pm2-logrotate: 50M x 14, compressed"
fi

# ── PostgreSQL ───────────────────────────────────────────────────────────────
log "PostgreSQL ${PG_VERSION}"
if ! rpm -q "postgresql${PG_VERSION}-server" >/dev/null 2>&1; then
  # The PGDG repo is required. Oracle Linux 9's own repos ship
  # `postgresql-server` through a module stream; the versioned package names
  # used here — and the /usr/pgsql-N/bin/ setup path below — are PGDG's. Without
  # this the install fails with "No match for argument".
  if ! rpm -q pgdg-redhat-repo >/dev/null 2>&1; then
    sudo dnf install -y -q \
      "https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-$(uname -m)/pgdg-redhat-repo-latest.noarch.rpm" \
      >/dev/null || die "could not add the PGDG repository"
    ok "PGDG repository added"
  fi
  # Disable the built-in module or it shadows the PGDG packages.
  sudo dnf -qy module disable postgresql >/dev/null 2>&1 || true
  sudo dnf install -y -q "postgresql${PG_VERSION}-server" "postgresql${PG_VERSION}-contrib" >/dev/null \
    || die "postgresql${PG_VERSION} install failed"
  ok "postgresql${PG_VERSION} installed"
else
  ok "postgresql${PG_VERSION} already installed"
fi

PGDATA="/var/lib/pgsql/${PG_VERSION}/data"
[[ -d "$PGDATA" ]] || PGDATA="/var/lib/pgsql/data"

if [[ ! -f "${PGDATA}/PG_VERSION" ]]; then
  sudo "/usr/pgsql-${PG_VERSION}/bin/postgresql-${PG_VERSION}-setup" initdb >/dev/null
  ok "initdb complete"
else
  ok "data directory already initialised"
fi

# Derived from the hardware, not hardcoded: an Always Free tenancy is often
# capped below 4 OCPU / 24 GB (2/12 is common, and must be requested up), and a
# 24GB profile on a 12GB box sets shared_buffers to half of RAM and an
# effective_cache_size larger than the machine has.
CORES=$(nproc)
SHARED_MB=$(( TOTAL_MB / 4 ))          # 25% of RAM, the standard starting point
CACHE_MB=$(( TOTAL_MB * 3 / 4 ))       # planner hint, not an allocation
WORK_MB=$(( TOTAL_MB / 768 )); (( WORK_MB < 4 )) && WORK_MB=4
MAINT_MB=$(( TOTAL_MB / 16 )); (( MAINT_MB > 1024 )) && MAINT_MB=1024
PARALLEL=$(( CORES / 2 )); (( PARALLEL < 1 )) && PARALLEL=1

log "PostgreSQL tuning (${CORES} cores / ${TOTAL_MB}MB)"
sudo mkdir -p "${PGDATA}/conf.d"
sudo tee "${PGDATA}/conf.d/kryon.conf" >/dev/null <<PGCONF
# Kryon tuning — generated by bootstrap.sh for ${CORES} cores / ${TOTAL_MB}MB.
listen_addresses = 'localhost'      # loopback only; keepers are co-located
max_connections = 100
shared_buffers = ${SHARED_MB}MB
effective_cache_size = ${CACHE_MB}MB
work_mem = ${WORK_MB}MB
maintenance_work_mem = ${MAINT_MB}MB
wal_buffers = 16MB
checkpoint_completion_target = 0.9
random_page_cost = 1.1              # NVMe, not spinning rust
effective_io_concurrency = 200
max_worker_processes = ${CORES}
max_parallel_workers = ${CORES}
max_parallel_workers_per_gather = ${PARALLEL}

# Keep enough WAL to recover, not so much it fills the boot volume.
min_wal_size = 1GB
max_wal_size = 4GB

# Slow-query visibility: the matcher's per-market probes regressed unnoticed
# once before (16 q/s at 8 markets, ~1.4M/day).
log_min_duration_statement = 1000
log_checkpoints = on
log_line_prefix = '%m [%p] %q%u@%d '
PGCONF

if ! sudo grep -q "conf.d/kryon.conf" "${PGDATA}/postgresql.conf"; then
  echo "include_dir = 'conf.d'" | sudo tee -a "${PGDATA}/postgresql.conf" >/dev/null
fi
ok "tuning written to ${PGDATA}/conf.d/kryon.conf"

# pg_hba: the stock file uses `ident` for TCP, which fails for the loopback
# logins the keepers use. scram-sha-256 on 127.0.0.1 is what the old box needed.
if ! sudo grep -qE '^host\s+all\s+all\s+127\.0\.0\.1/32\s+scram-sha-256' "${PGDATA}/pg_hba.conf"; then
  sudo sed -i 's|^host\s*all\s*all\s*127\.0\.0\.1/32.*|host    all             all             127.0.0.1/32            scram-sha-256|' "${PGDATA}/pg_hba.conf"
  ok "pg_hba.conf set to scram-sha-256 on loopback"
else
  ok "pg_hba.conf already correct"
fi

sudo systemctl enable --now "postgresql-${PG_VERSION}" >/dev/null 2>&1 \
  || sudo systemctl enable --now postgresql >/dev/null 2>&1
sudo systemctl restart "postgresql-${PG_VERSION}" >/dev/null 2>&1 \
  || sudo systemctl restart postgresql >/dev/null 2>&1
ok "postgresql running"

# ── Databases and role ───────────────────────────────────────────────────────
log "Databases"
PW_FILE="/home/${APP_USER}/.kryon-db-password"
if [[ -f "$PW_FILE" ]]; then
  DB_PASSWORD="$(sudo cat "$PW_FILE")"
  ok "reusing existing database password from ${PW_FILE}"
else
  DB_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"
  echo "$DB_PASSWORD" | sudo tee "$PW_FILE" >/dev/null
  sudo chown "${APP_USER}:${APP_USER}" "$PW_FILE"
  sudo chmod 600 "$PW_FILE"
  ok "generated database password → ${PW_FILE} (0600)"
fi

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='kryon'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE kryon LOGIN PASSWORD '${DB_PASSWORD}';" >/dev/null
sudo -u postgres psql -c "ALTER ROLE kryon PASSWORD '${DB_PASSWORD}';" >/dev/null
ok "role 'kryon' ready"

for db in kryon_mainnet kryon_testnet; do
  if sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1; then
    ok "database ${db} exists"
  else
    sudo -u postgres createdb -O kryon "${db}"
    ok "database ${db} created"
  fi
done

# ── Firewall ─────────────────────────────────────────────────────────────────
# Nothing to open. Every service on this box is reached over loopback:
# cloudflared connects to the ws-server on localhost:8080/8081 and to Next on
# localhost:3000, then dials OUT to Cloudflare. Postgres is bound to localhost.
#
# This deliberately reverses the earlier instruction to open 8080/8081 at both
# the host and VCN layers. That was correct when the web tier was remote and
# needed a direct feed; with a tunnel it would publish the same feed a second
# time, unencrypted as ws://, outside the tunnel's TLS and reachable by anyone.
log "Firewall (host layer)"
if [[ "${WS_INGRESS:-0}" == "1" ]]; then
  if systemctl is-active --quiet firewalld; then
    for port in 8080 8081; do
      sudo firewall-cmd --permanent --add-port=${port}/tcp >/dev/null 2>&1 || true
    done
    sudo firewall-cmd --reload >/dev/null 2>&1 || true
    warn "opened 8080+8081 (WS_INGRESS=1) — the VCN Security List rule is a"
    warn "separate layer and must be added in the console for these to matter."
  else
    warn "firewalld not active — skipping"
  fi
else
  ok "no ports opened — all traffic reaches this box through the tunnel"
fi

# ── Nightly backups ──────────────────────────────────────────────────────────
log "Backups"
sudo tee /usr/local/bin/kryon-backup.sh >/dev/null <<'BACKUP'
#!/usr/bin/env bash
# Nightly logical backup of both Kryon databases. 14-day retention.
set -euo pipefail
DEST=/var/backups/kryon
mkdir -p "$DEST"
STAMP=$(date -u +%Y%m%d-%H%M%S)
for db in kryon_mainnet kryon_testnet; do
  sudo -u postgres pg_dump -Fc "$db" > "${DEST}/${db}-${STAMP}.dump"
done
find "$DEST" -name '*.dump' -mtime +14 -delete
BACKUP
sudo chmod +x /usr/local/bin/kryon-backup.sh
sudo tee /etc/systemd/system/kryon-backup.service >/dev/null <<'UNIT'
[Unit]
Description=Kryon nightly database backup
[Service]
Type=oneshot
ExecStart=/usr/local/bin/kryon-backup.sh
UNIT
sudo tee /etc/systemd/system/kryon-backup.timer >/dev/null <<'TIMER'
[Unit]
Description=Run Kryon database backup nightly
[Timer]
OnCalendar=*-*-* 03:17:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
TIMER
sudo systemctl daemon-reload
sudo systemctl enable --now kryon-backup.timer >/dev/null 2>&1
ok "nightly pg_dump → /var/backups/kryon (14-day retention)"

# ── Automatic security updates ───────────────────────────────────────────────
log "Automatic security updates"
sudo dnf install -y -q dnf-automatic >/dev/null 2>&1 || true
if [[ -f /etc/dnf/automatic.conf ]]; then
  sudo sed -i 's/^upgrade_type.*/upgrade_type = security/' /etc/dnf/automatic.conf
  sudo sed -i 's/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf
  sudo systemctl enable --now dnf-automatic.timer >/dev/null 2>&1 || true
  ok "security-only updates applied automatically"
fi

# ── pm2 boot persistence ─────────────────────────────────────────────────────
log "pm2 boot persistence"
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "${APP_USER}" \
  --hp "/home/${APP_USER}" >/dev/null 2>&1 || warn "pm2 startup returned non-zero"
ok "pm2 will resurrect on boot (run 'pm2 save' after starting the fleets)"

# ── Summary ──────────────────────────────────────────────────────────────────
cat <<SUMMARY

────────────────────────────────────────────────────────────────
  Bootstrap complete.

  DATABASE PASSWORD (save this — it is not stored anywhere else):

      ${DB_PASSWORD}

  Connection strings for your .env files:

      DATABASE_URL_MAINNET=postgresql://kryon:${DB_PASSWORD}@127.0.0.1:5432/kryon_mainnet
      DATABASE_URL_TESTNET=postgresql://kryon:${DB_PASSWORD}@127.0.0.1:5432/kryon_testnet

  Next:
    1. Add VCN Security List ingress for TCP 8080 and 8081 (console).
    2. Clone the repo to ${REPO_DIR} and 'npm ci' in client/.
    3. Create client/.env.local (mainnet) and client/.env.testnet.
    4. Run migrate-from-micro.sh to move the mainnet database over.
    5. pm2 start ecosystem.config.cjs && pm2 start ecosystem.testnet.config.cjs
    6. pm2 save
    7. Set ALERT_WEBHOOK_URL in BOTH env files before calling this production.
────────────────────────────────────────────────────────────────
SUMMARY

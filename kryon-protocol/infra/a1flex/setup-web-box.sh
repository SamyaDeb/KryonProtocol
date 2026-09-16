#!/usr/bin/env bash
#
# setup-web-box.sh — prepare a fresh micro instance to serve the Next.js
# standalone bundle behind a Cloudflare Tunnel. RUN ON THE WEB BOX.
#
# Every choice here is a scar. On a 1GB Oracle Linux 9 micro:
#
#  1. NEVER use dnf for anything avoidable. `dnf install nodejs` with the
#     NodeSource repo present took the box to 42MB free and wedged the kernel
#     twice — and dnf-makecache.timer then did it again on a schedule, without
#     anyone typing a command. Node comes from a tarball, cloudflared from a
#     raw binary. No repo metadata, no dependency solver.
#  2. .tar.gz, not .tar.xz. This shape is 1/8 OCPU and xz decompression is
#     heavily CPU-bound.
#  3. Oracle Linux 9 reserves 448MB of a 1GB box for crashkernel. Reclaim it or
#     you are running a 498MB machine.
#  4. SELinux denies init_t BOTH the execmem that Node's JIT needs AND
#     name_connect to postgresql_port_t, and a dontaudit
#     rule hides the denial. V8 asserts the failed mmap was ENOMEM, gets
#     EACCES, and aborts with "Check failed: 12 == (*__errno_location ())" —
#     an error that never mentions permissions. Diagnosed by `setenforce 0`
#     making it serve 200, then `semodule -DB` to unhide the AVC.
#
set -euo pipefail
ok()  { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

NODE_V="${NODE_V:-v22.14.0}"
APP_DIR="${APP_DIR:-/opt/kryon-web}"

log "Disarming dnf"
sudo systemctl disable --now dnf-makecache.timer >/dev/null 2>&1 || true
sudo systemctl disable --now dnf-automatic.timer >/dev/null 2>&1 || true
sudo rm -f /etc/yum.repos.d/nodesource*.repo
ok "dnf timers off, nodesource repos removed"

log "Reclaiming crashkernel memory"
if [[ "$(cat /sys/kernel/kexec_crash_size 2>/dev/null || echo 0)" != "0" ]]; then
  sudo systemctl disable --now kdump >/dev/null 2>&1 || true
  sudo grubby --update-kernel=ALL --remove-args=crashkernel >/dev/null 2>&1
  sudo grubby --update-kernel=ALL --args="crashkernel=no" >/dev/null 2>&1
  ok "crashkernel disabled — REBOOT REQUIRED to reclaim ~448MB"
else
  ok "already reclaimed ($(free -m | awk '/^Mem:/{print $2}')MB visible)"
fi

log "Swap"
if [[ "$(swapon --show=SIZE --noheadings | head -1)" != "2G" ]]; then
  sudo swapoff -a || true; sudo rm -f /swapfile /.swapfile
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
ok "swap $(free -m | awk '/^Swap:/{print $2}')MB"

log "Node ${NODE_V} (tarball)"
if ! command -v node >/dev/null; then
  curl -fsSL -o /tmp/node.tar.gz "https://nodejs.org/dist/${NODE_V}/node-${NODE_V}-linux-x64.tar.gz"
  sudo mkdir -p /usr/local/lib/nodejs
  sudo tar -xzf /tmp/node.tar.gz -C /usr/local/lib/nodejs
  for b in node npm npx; do
    sudo ln -sf "/usr/local/lib/nodejs/node-${NODE_V}-linux-x64/bin/${b}" "/usr/local/bin/${b}"
  done
  rm -f /tmp/node.tar.gz
fi
ok "node $(node -v)"

log "cloudflared (raw binary)"
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  sudo install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared && rm -f /tmp/cloudflared
fi
ok "$(cloudflared --version | head -1)"

log "SELinux policy for Node's JIT"
if ! sudo semodule -l 2>/dev/null | grep -q '^kryon-node'; then
  cd /tmp
  cat > kryon-node.te <<'TE'
module kryon-node 1.0;

require {
    type init_t;
    type postgresql_port_t;
    class process execmem;
    class tcp_socket name_connect;
}

# JIT: V8 maps writable-executable memory. Denied for init_t and hidden by a
# dontaudit rule; V8 asserts the failed mmap was ENOMEM, gets EACCES, and
# aborts with "Check failed: 12 == (*__errno_location ())".
allow init_t self:process execmem;

# Database: the web tier connects to Postgres on another host across the VCN.
# Without this, connect() fails EACCES and every database route returns
# readiness_unavailable while the service looks healthy and serves / with 200.
allow init_t postgresql_port_t:tcp_socket name_connect;
TE
  checkmodule -M -m -o kryon-node.mod kryon-node.te >/dev/null
  semodule_package -o kryon-node.pp -m kryon-node.mod
  sudo semodule -i kryon-node.pp
fi
ok "kryon-node policy installed (SELinux stays Enforcing)"

log "Service"
sudo mkdir -p "$APP_DIR" && sudo chown "$(id -un):$(id -gn)" "$APP_DIR"
sudo restorecon -RF "$APP_DIR" 2>/dev/null || true
ok "$APP_DIR ready ($(ls -Zd "$APP_DIR" | awk '{print $1}'))"

echo
echo "Next: ship the bundle with ship-web-tier.sh, then install kryon-web.service."

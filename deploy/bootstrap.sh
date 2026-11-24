#!/usr/bin/env bash
# Binflip VPS bootstrap — run ONCE as root on a fresh Ubuntu 24.04 server:
#   curl -fsSL <raw url>/deploy/bootstrap.sh -o bootstrap.sh && less bootstrap.sh && sudo bash bootstrap.sh
# Idempotent: safe to run again.
#
# What it does:
#   - creates user "binflip" (docker group), copies root's authorized_keys to it
#   - SSH: key-only, no root login, no passwords   (only if binflip has a key — never locks you out)
#   - firewall: only SSH open (panel/API stay on localhost; use an SSH tunnel)
#   - fail2ban, unattended security upgrades, UTC time, 2G swap, journald size cap
#   - Docker Engine + compose plugin from Docker's official repository, log rotation
set -euo pipefail

APP_USER="${APP_USER:-binflip}"
SSH_PORT="${SSH_PORT:-22}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo bash bootstrap.sh)"; exit 1; }
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || echo "warning: tested on Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}"

log "System update"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades git jq htop

log "Time zone: UTC"
timedatectl set-timezone UTC || true

log "User ${APP_USER}"
if ! id "$APP_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$APP_USER"
fi
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/.ssh"
if [ -f /root/.ssh/authorized_keys ] && [ ! -s "/home/$APP_USER/.ssh/authorized_keys" ]; then
  install -m 600 -o "$APP_USER" -g "$APP_USER" /root/.ssh/authorized_keys "/home/$APP_USER/.ssh/authorized_keys"
fi

log "Docker Engine (official repository)"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
install -d /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" }, "live-restore": true }
JSON
  systemctl restart docker
fi
usermod -aG docker "$APP_USER"
systemctl enable --now docker

log "Swap 2G (helps builds on small VPS)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "journald size cap"
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/binflip.conf
systemctl restart systemd-journald

log "Unattended security upgrades"
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

log "Firewall: only SSH"
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp"
ufw --force enable

log "fail2ban (sshd)"
cat > /etc/fail2ban/jail.d/binflip.conf <<CONF
[sshd]
enabled = true
port = ${SSH_PORT}
maxretry = 5
bantime = 1h
CONF
systemctl enable --now fail2ban
systemctl restart fail2ban

log "SSH hardening"
if [ -s "/home/$APP_USER/.ssh/authorized_keys" ]; then
  # sshd keeps the FIRST value it reads and includes sshd_config.d/*.conf in name order:
  # 00- beats cloud images' 50-cloud-init.conf (which may say PasswordAuthentication yes).
  rm -f /etc/ssh/sshd_config.d/99-binflip.conf
  cat > /etc/ssh/sshd_config.d/00-binflip.conf <<CONF
Port ${SSH_PORT}
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers ${APP_USER}
CONF
  sshd -t && systemctl reload ssh || systemctl reload sshd
  echo "SSH is now key-only for user ${APP_USER}. Test a NEW session before closing this one:"
  echo "  ssh ${APP_USER}@<server-ip> -p ${SSH_PORT}"
else
  echo "!! ${APP_USER} has no SSH key yet: SSH hardening SKIPPED so you are not locked out."
  echo "   Add your public key to /home/${APP_USER}/.ssh/authorized_keys and run this script again."
fi

log "App directories"
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/binflip-data"
echo
echo "Done. Next: log in as ${APP_USER} and follow deploy/README.md (step 3)."

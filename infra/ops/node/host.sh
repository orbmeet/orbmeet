#!/usr/bin/env bash
# Everything about the host outside its containers: helpers, systemd units,
# Docker's settings, kernel settings and the firewall. Idempotent; run by every
# deploy.sh apply, after it installs /etc/orbmeet/host.env and the runtime files.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root'; exit 1; }
cd "$(dirname "$0")"
source /etc/orbmeet/host.env
[[ "$SERVICES" =~ ^[a-z]+( [a-z]+)*$ ]]

install -m 755 firewall.sh /usr/local/sbin/orbmeet-firewall
install -m 755 health.sh /usr/local/sbin/orbmeet-health
install -m 755 ship-logs.sh /usr/local/sbin/orbmeet-ship-logs
install -d /usr/local/lib/orbmeet
install -m 644 ship-logs.jq /usr/local/lib/orbmeet/ship-logs.jq

# The journal keeps every container's log (below); its own settings restart
# only it, which loses no entries.
install -d /etc/systemd/journald.conf.d
if ! cmp -s host/journald.conf /etc/systemd/journald.conf.d/orbmeet.conf; then
  install -m 644 host/journald.conf /etc/systemd/journald.conf.d/orbmeet.conf
  systemctl restart systemd-journald.service
fi

# Docker's own settings: the only change here that restarts it.
docker_config() {
  { cat /etc/docker/daemon.json /etc/systemd/system/docker.service.d/orbmeet.conf 2>/dev/null || true; } | sha256sum
}
before=$(docker_config)
install -d /etc/docker /etc/systemd/system/docker.service.d
install -m 644 systemd/docker.service.d/orbmeet.conf /etc/systemd/system/docker.service.d/
# Merge our policy rather than discarding unrelated daemon settings. The rename
# means a failed merge leaves the old file, never an empty one. The journal
# takes none of the local driver's log-opts, and Docker refuses to start with them.
jq 'del(."log-opts") + {"live-restore": true, "log-driver": "journald"}' \
  <(cat /etc/docker/daemon.json 2>/dev/null || echo '{}') > /etc/docker/daemon.json.new
mv /etc/docker/daemon.json.new /etc/docker/daemon.json

install -m 644 host/modules.conf /etc/modules-load.d/orbmeet.conf
modprobe br_netfilter
install -m 644 host/sysctl.conf /etc/sysctl.d/90-orbmeet.conf
sysctl -q -p /etc/sysctl.d/90-orbmeet.conf

install -m 644 systemd/orbmeet-firewall.service systemd/orbmeet-health.service systemd/orbmeet-health.timer \
  systemd/orbmeet-ship-logs.service systemd/orbmeet-ship-logs.timer /etc/systemd/system/
# Whiteboard backup runs from before the server saved each board to R2 as it
# changes (apps/whiteboard-server/src/persistence/room-copies.ts), and the
# failure alert from before the node shipped its logs, health results included.
legacy_units=(orbmeet-whiteboard-backup@.service orbmeet-whiteboard-backup-full.timer
  orbmeet-whiteboard-backup-changed.timer orbmeet-whiteboard-restore-verify.service
  orbmeet-whiteboard-restore-verify.timer orbmeet-alert@.service)
systemctl disable --now orbmeet-whiteboard-backup-full.timer orbmeet-whiteboard-backup-changed.timer \
  orbmeet-whiteboard-restore-verify.timer 2>/dev/null || true
rm -f "${legacy_units[@]/#//etc/systemd/system/}" /usr/local/sbin/orbmeet-whiteboard /usr/local/sbin/orbmeet-alert
rm -rf /run/orbmeet-alert
systemctl daemon-reload
systemctl enable --now --quiet orbmeet-ship-logs.timer

# Apply this deploy's rules now. Never restart orbmeet-firewall.service: Docker
# Requires= it, so restarting it would restart Docker too.
systemctl enable --quiet orbmeet-firewall.service
systemctl is-active --quiet orbmeet-firewall.service || systemctl start orbmeet-firewall.service
/usr/local/sbin/orbmeet-firewall

systemctl enable --quiet docker.service
if [[ $(docker_config) != "$before" ]] || ! systemctl is-active --quiet docker.service; then
  # live-restore keeps containers running while the daemon restarts.
  systemctl restart docker.service
fi
# Cloud images enable rpcbind for NFS, which nothing here uses.
systemctl disable --now rpcbind.socket rpcbind.service 2>/dev/null || true
# deploy.sh enables the health timer once the node runs its stack: a host
# with nothing running yet would report itself unhealthy.

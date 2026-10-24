#!/usr/bin/env bash
# Apply the node's firewall as rendered by the ops tool (render.ts firewallRules). Only the
# ORBMEET chains are replaced; OCI's InstanceServices OUTPUT policy is preserved.
set -euo pipefail
RULES=${RULES:-/etc/orbmeet/runtime}

for tool in iptables ip6tables; do
  "$tool" -w -N ORBMEET-INPUT 2>/dev/null || true
  "$tool" -w -C INPUT -j ORBMEET-INPUT 2>/dev/null || "$tool" -w -I INPUT 1 -j ORBMEET-INPUT
done
iptables -w -N DOCKER-USER 2>/dev/null || true
iptables -w -N ORBMEET-FORWARD 2>/dev/null || true
iptables -w -C FORWARD -j DOCKER-USER 2>/dev/null || iptables -w -I FORWARD 1 -j DOCKER-USER
iptables -w -C DOCKER-USER -j ORBMEET-FORWARD 2>/dev/null || iptables -w -I DOCKER-USER 1 -j ORBMEET-FORWARD

# Each file replaces its chains in one transaction, never leaving them empty.
iptables-restore --wait 5 --noflush < "$RULES/firewall.v4"
ip6tables-restore --wait 5 --noflush < "$RULES/firewall.v6"

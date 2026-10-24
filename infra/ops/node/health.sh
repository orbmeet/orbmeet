#!/usr/bin/env bash
# orbmeet-health [check]
#
# This node's firewall, containers and the paths between them: minutely from
# orbmeet-health.timer, and after every deploy. Whether a node takes Meetings is
# the Worker's decision: it probes every media node's LiveKit API itself.
set -euo pipefail
source /etc/orbmeet/host.env
fail() { echo "FAIL readiness: $*" >&2; exit 1; }
[[ ${1:-check} == check ]] || fail "unknown action $1"
read -ra services <<<"$SERVICES"
runs() { [[ " $SERVICES " == *" $1 "* ]]; }

for tool in iptables ip6tables; do
  "$tool" -w -C INPUT -j ORBMEET-INPUT 2>/dev/null || fail "$tool: ORBMEET-INPUT is not in INPUT"
  rules=$("$tool" -w -S ORBMEET-INPUT)
  grep -qxF -- '-A ORBMEET-INPUT -i om-+ -j DROP' <<<"$rules" && [[ $rules == *'-j DROP' ]] \
    || fail "$tool: host isolation policy is incomplete"
done
iptables -w -C FORWARD -j DOCKER-USER 2>/dev/null && iptables -w -C DOCKER-USER -j ORBMEET-FORWARD 2>/dev/null \
  || fail 'iptables: container forwarding policy is not in FORWARD'

# Each service runs exactly one container, and Docker reports it healthy. The
# healthchecks in compose.yaml cover each service's own readiness and its
# dependencies: LiveKit, Redis, Egress, the whiteboard and the transcription agent.
container() {
  local ids
  ids=$(docker ps -q --filter "label=com.docker.compose.project=orbmeet-$NODE" \
    --filter "label=com.docker.compose.service=$1")
  [[ $(wc -w <<<"$ids") == 1 ]] || fail "$1: expected one running container, found $(wc -w <<<"$ids")"
  echo "$ids"
}
for service in "${services[@]}"; do
  id=$(container "$service")
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")
  [[ -z $health || $health == healthy ]] || fail "$service is $health"
done

# LiveKit's media sockets are on the host network, where its healthcheck cannot see them.
if runs livekit; then
  conf=/etc/orbmeet/runtime/livekit.json
  range=$(jq -r .rtc.udp_port "$conf")
  listening=$(ss -Hlun | awk '{ n = split($4, a, ":"); print a[n] }' | sort -u)
  for port in $(seq "${range%-*}" "${range#*-}") "$(jq -r .turn.udp_port "$conf")"; do
    grep -qx "$port" <<<"$listening" || fail "LiveKit does not listen on UDP $port"
  done
fi

if runs egress; then
  id=$(container egress)
  (( $(sysctl -n user.max_user_namespaces) > 0 )) || fail 'Chrome requires user namespaces'
  # The actual seccomp and user-namespace posture, not just the host sysctl.
  docker exec "$id" unshare -Ur true || fail "Egress cannot create Chrome's sandbox namespaces"
  # Unauthenticated, Redis answers NOAUTH: the path across the bridge is open,
  # and its password never leaves its file.
  docker exec "$id" timeout 5 bash -c 'exec 3<>/dev/tcp/172.30.22.10/6379 && printf "PING\r\n" >&3 &&
    read -r -t 3 reply <&3 && [[ $reply == -NOAUTH* ]]' || fail 'Egress cannot reach Redis'
fi
echo "PASS $NODE: host policy, application readiness and dependency connectivity"

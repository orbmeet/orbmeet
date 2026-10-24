#!/usr/bin/env bash
# Runs on a node, as root, from the source and runtime files the ops tool synced here.
#
#   deploy.sh build   install Docker if missing, pull and build; changes nothing that runs
#   deploy.sh plan    print the Compose services an apply would create, replace or remove
#   deploy.sh apply   converge the host, install the configuration, start and retire services
#
# The ops tool builds every node before applying any, and asks before an apply
# whose plan restarts a media service under live rooms or a recording. Clients
# reconnect by themselves; a recording in progress is lost.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root'; exit 1; }
cd "$(dirname "$0")"
source .runtime/host.env
[[ "$NODE" =~ ^[a-z][a-z0-9-]*$ && "$SERVICES" =~ ^[a-z]+( [a-z]+)*$ ]]
project=orbmeet-$NODE
base=(docker compose -p "$project" --env-file .runtime/compose.env -f compose.yaml)
# Every Compose service has a profile of its own name.
compose=("${base[@]}")
for service in $SERVICES; do compose+=(--profile "$service"); done

mode=${1:-}
assigned() { [[ " $SERVICES " == *" $1 "* ]]; }

# Docker's release signing key: https://docs.docker.com/engine/install/ubuntu/
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

# A fresh host gets Docker on its first deploy, from Docker's own repository
# rather than the distribution's older docker.io; everything else about the
# host is host.sh's. A host that already runs Docker keeps the one it has.
packages() {
  command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1 \
    && command -v jq >/dev/null && command -v curl >/dev/null && return
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg jq
  if ! command -v docker >/dev/null; then
    local key
    key=$(mktemp)
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key"
    gpg --show-keys --with-colons "$key" | grep -qx "fpr:::::::::$DOCKER_KEY_FINGERPRINT:" \
      || { rm -f "$key"; echo "Docker's signing key does not have the expected fingerprint"; exit 1; }
    install -d -m 755 /etc/apt/keyrings
    install -m 644 "$key" /etc/apt/keyrings/docker.asc
    rm -f "$key"
    # shellcheck source=/dev/null
    cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
}

build() {
  "${compose[@]}" config --quiet
  "${compose[@]}" pull --quiet --ignore-buildable
  BUILDX_NO_DEFAULT_ATTESTATIONS=1 "${compose[@]}" build --quiet --provenance=false
}

# A service is pending when its running container is missing or was created
# from a different configuration (Compose's own config hash, which covers the
# image tag and the rendered-config labels), or when it runs but is no longer
# assigned.
pending() {
  "${compose[@]}" config --hash '*' | while read -r service hash; do
    assigned "$service" || continue
    [[ -n $(docker ps -q --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=$service" \
      --filter "label=com.docker.compose.config-hash=$hash") ]] || echo "$service"
  done
  docker ps --filter "label=com.docker.compose.project=$project" \
    --format '{{.Label "com.docker.compose.service"}}' | sort -u | grep -vxF -f <(printf '%s\n' $SERVICES) || true
}

case $mode in
  build) packages; build; exit 0 ;;
  plan) "${compose[@]}" config --quiet; pending | sort -u; exit 0 ;;
  apply) ;;
  *) echo 'Usage: deploy.sh build|plan|apply [service...]'; exit 2 ;;
esac

exec 9>/run/lock/orbmeet-deploy.lock
flock -n 9 || { echo 'Another deploy is running'; exit 1; }
if assigned egress; then
  [[ $(sysctl -n user.max_user_namespaces) -gt 0 ]] || { echo 'Chrome requires user namespaces'; exit 1; }
fi
# Normally cached by the build step; repeated so an apply never runs an image it lacks.
build
# Validate before replacing any running configuration. No public listeners.
source .runtime/compose.env
if assigned caddy; then
  docker run --rm --network none --user 0 --entrypoint caddy \
    -v "$PWD/.runtime/Caddyfile:/etc/caddy/Caddyfile:ro" "orbmeet-caddy:$CADDY_BUILD" \
    validate --config /etc/caddy/Caddyfile --adapter caddyfile
fi

# The configuration is rendered entirely from git and the operator's secrets,
# so an interrupted copy is repaired by rerunning the deploy. Rollback is a
# deploy of the earlier revision.
install -d -m 700 /etc/orbmeet /etc/orbmeet/runtime /var/lib/orbmeet
install -m 600 .runtime/host.env /etc/orbmeet/host.env
rsync -rpc --delete --chmod=D700,F444 --exclude=compose.env --exclude=host.env .runtime/ /etc/orbmeet/runtime/
# Data directories owned by the user each image runs as.
declare -A owners=([caddy]=10000:10000 [whiteboard]=10001:10001)
for service in caddy whiteboard egress transcription; do
  assigned "$service" || continue
  owner=${owners[$service]:-}
  if [[ -z $owner ]]; then
    image=$("${compose[@]}" config --images "$service")
    owner=$(docker run --rm --network none --entrypoint id "$image" -u):$(docker run --rm --network none --entrypoint id "$image" -g)
  fi
  install -d -m 750 "/var/lib/orbmeet/$service"
  chown "$owner" "/var/lib/orbmeet/$service"
done
# Host settings, units and the firewall before any container: a service this
# deploy adds, such as the whiteboard moving here, must not start before the
# rules it needs. They come from the inventory alone, so they are safe ahead
# of the containers.
bash host.sh
# The minutely check would report containers mid-replacement as failures. It
# resumes however this deploy ends, and reports a failed one.
systemctl stop orbmeet-health.timer
trap 'systemctl enable --now orbmeet-health.timer' EXIT
# --remove-orphans: a service deleted from compose.yaml has no name left to
# retire it by below.
"${compose[@]}" up -d --wait --wait-timeout 240 --remove-orphans
# A service the node no longer runs is removed. Data directories stay;
# /var/lib/orbmeet/whiteboard is never deleted: its rooms are saved to R2 as
# they change, but a room whose last save failed is recovered from here.
mapfile -t retired < <("${base[@]}" --profile '*' config --services | grep -vxF -f <(printf '%s\n' $SERVICES))
if (( ${#retired[@]} )); then
  "${base[@]}" --profile '*' stop "${retired[@]}"
  if [[ " ${retired[*]} " == *" whiteboard "* ]]; then
    while read -r container; do
      [[ -n "$container" ]] || continue
      if [[ $(docker inspect --format '{{.State.ExitCode}}' "$container") != 0 ]]; then
        echo 'Whiteboard did not shut down cleanly; retain the container and /var/lib/orbmeet/whiteboard, and recover on this host before moving the boards.' >&2
        exit 1
      fi
    done < <("${base[@]}" --profile '*' ps -aq whiteboard)
  fi
  "${base[@]}" --profile '*' rm --force "${retired[@]}"
fi
# So is a network compose.yaml no longer has, now that nothing uses it.
declared=$("${base[@]}" --profile '*' config --format json | jq -r '.networks | keys[]')
while read -r network; do
  [[ -n "$network" ]] || continue
  grep -qxF "${network#"${project}_"}" <<<"$declared" || docker network rm "$network" >/dev/null
done < <(docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}')
/usr/local/sbin/orbmeet-health check
# Every deploy builds new image tags; drop the ones no container uses and old
# build cache, or the disk fills a gigabyte or two per deploy.
docker image prune --all --force --filter until=72h >/dev/null
docker builder prune --force --filter until=72h >/dev/null
"${compose[@]}" ps

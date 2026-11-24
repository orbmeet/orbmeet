#!/usr/bin/env bash
# orbmeet-ship-logs: send what this node logged since the last run to Axiom,
# every five minutes from orbmeet-ship-logs.timer. ship-logs.jq chooses which
# entries go. Each run also sends one heartbeat carrying the node's health,
# and an event when the health check's result changes, rather than every
# result: a failing check fails every minute.
#
# The journal holds every container's output (Docker's journald log driver)
# and survives containers being replaced. A run resumes after the last entry
# the previous delivered run read, so nothing is skipped; a run that cannot
# deliver fails without moving its state, and the next sends the same again.
set -euo pipefail
source /etc/orbmeet/host.env
state=/var/lib/orbmeet/ship-logs
install -d -m 700 "$state"
trap 'rm -f "$state/entries" "$state/chunk" "$state/batch" "$state/cursor.new" "$state/auth"' EXIT

if [[ -s $state/cursor ]]; then
  from=(--after-cursor="$(<"$state/cursor")")
else
  # A node's first run sends the recent past, not its whole journal.
  from=(--since=-15min)
fi
# --all: without it a field over 4096 bytes reads as null, and a long line
# would arrive as an empty one.
journalctl "${from[@]}" -o json --all --no-pager > "$state/entries"

# A line Docker is still writing in parts (see ship-logs.jq) is left to the
# next run, from its first part on, with every entry after it: the cursor
# stops before it. One whose last part is a minute overdue will not come (its
# container stopped mid-line), and goes as it is.
held=$(jq -rn --argjson now "$(date +%s)" '
  reduce inputs as $entry ({line: 0, open: {}};
    .line += 1
    | ($entry.CONTAINER_PARTIAL_ID) as $id
    | if $id == null then .
      elif $entry.CONTAINER_PARTIAL_LAST == "true" then del(.open[$id])
      else .open[$id] //= {line, at: ($entry.__REALTIME_TIMESTAMP | tonumber / 1000000)} end)
  | [.open[] | select($now - .at < 60) | .line] | min // empty' "$state/entries")
if [[ -n $held ]]; then
  # Not sed -i: its in-place syntax differs between GNU and BSD sed, and the
  # tests run this script on the operator's machine as well as the nodes.
  head -n "$((held - 1))" "$state/entries" > "$state/entries.held"
  mv "$state/entries.held" "$state/entries"
fi

# The health check's latest result in this run's entries: its PASS or FAIL
# line, or systemd's word that it did not finish. A check killed at its
# timeout (Docker hanging) or dying before it could say why prints nothing of
# its own, and must not read as the last PASS.
latest=$(jq -r '
  if .SYSLOG_IDENTIFIER == "orbmeet-health" and (.MESSAGE | type) == "string"
    and (.MESSAGE | startswith("PASS") or startswith("FAIL")) then .MESSAGE
  elif .UNIT == "orbmeet-health.service" and (.MESSAGE | type) == "string"
    and (.MESSAGE | test("Failed with result")) then
    "FAIL readiness: the check did not finish (" + (.MESSAGE | capture("result .(?<why>[a-z-]+).") .why) + ")"
  else empty end' "$state/entries" | tail -n 1)
previous=$(cat "$state/health" 2>/dev/null || echo PASS)
health=${latest%% *}
health=${health:-$previous}
# Seconds are enough for a heartbeat, and this format is the same in GNU and BSD date.
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# The token goes in a header file: on curl's command line it would be in
# /proc/<pid>/cmdline for anyone on the node to read. printf is a builtin.
printf 'Authorization: Bearer %s\n' "$AXIOM_TOKEN" > "$state/auth"

post() {
  jq -s . "$1" \
    | curl -fsS --max-time 30 -H @"$state/auth" -H "Content-Type: application/json" \
        --data-binary @- "https://api.axiom.co/v1/datasets/$AXIOM_DATASET/ingest" >/dev/null
}

# What closes the run: the health check's result when it changed, and the heartbeat.
finish() {
  if [[ $health != "$previous" ]]; then
    jq -nc --arg node "$NODE" --arg time "$now" --arg line "$latest" \
      '{_time: $time, source: "node", node: $node, service: "health",
        level: (if ($line | startswith("FAIL")) then "error" else "info" end), msg: $line}' >> "$1"
  fi
  jq -nc --arg node "$NODE" --arg time "$now" --argjson healthy "$([[ $health == PASS ]] && echo true || echo false)" \
    '{_time: $time, source: "node", node: $node, service: "shipper", level: "info", msg: "heartbeat", healthy: $healthy}' \
    >> "$1"
}

# Sent in chunks, the cursor moving after each: a backlog from an outage goes
# as several requests, each small enough to land, rather than as one that
# grows with every failed run until none ever can. A chunk ends only between
# whole lines, never among the parts of one Docker wrote in pieces.
chunk_lines=${SHIP_LOGS_CHUNK_LINES:-2000}
total=$(wc -l < "$state/entries" | tr -d ' ')
start=1
while (( start <= total )); do
  end=$(( start + chunk_lines - 1 ))
  (( end > total )) && end=$total
  while (( end < total )) && [[ $(sed -n "${end}p" "$state/entries" \
      | jq -r '.CONTAINER_PARTIAL_ID == null or .CONTAINER_PARTIAL_LAST == "true"') != true ]]; do
    end=$(( end + 1 ))
  done
  sed -n "${start},${end}p" "$state/entries" > "$state/chunk"
  jq -nc --arg node "$NODE" -f /usr/local/lib/orbmeet/ship-logs.jq "$state/chunk" > "$state/batch"
  (( end == total )) && finish "$state/batch"
  post "$state/batch"
  tail -n 1 "$state/chunk" | jq -r .__CURSOR > "$state/cursor.new"
  mv "$state/cursor.new" "$state/cursor"
  start=$(( end + 1 ))
done
if (( total == 0 )); then
  : > "$state/batch"
  finish "$state/batch"
  post "$state/batch"
fi
printf '%s\n' "$health" > "$state/health"

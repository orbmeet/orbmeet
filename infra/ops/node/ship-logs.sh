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
trap 'rm -f "$state/entries" "$state/batch" "$state/cursor.new"' EXIT

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
  sed -i "${held},\$d" "$state/entries"
fi

jq -nc --arg node "$NODE" -f /usr/local/lib/orbmeet/ship-logs.jq "$state/entries" > "$state/batch"

# The health check's latest result in this run's entries: PASS or FAIL, with its line.
latest=$(jq -r 'select(.SYSLOG_IDENTIFIER == "orbmeet-health" and (.MESSAGE | type) == "string")
  | .MESSAGE | select(startswith("PASS") or startswith("FAIL"))' "$state/entries" | tail -n 1)
previous=$(cat "$state/health" 2>/dev/null || echo PASS)
health=${latest%% *}
health=${health:-$previous}
now=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
if [[ $health != "$previous" ]]; then
  jq -nc --arg node "$NODE" --arg time "$now" --arg line "$latest" \
    '{_time: $time, source: "node", node: $node, service: "health",
      level: (if ($line | startswith("FAIL")) then "error" else "info" end), msg: $line}' >> "$state/batch"
fi
jq -nc --arg node "$NODE" --arg time "$now" --argjson healthy "$([[ $health == PASS ]] && echo true || echo false)" \
  '{_time: $time, source: "node", node: $node, service: "shipper", level: "info", msg: "heartbeat", healthy: $healthy}' \
  >> "$state/batch"

jq -s . "$state/batch" \
  | curl -fsS --max-time 30 -H "Authorization: Bearer $AXIOM_TOKEN" -H "Content-Type: application/json" \
      --data-binary @- "https://api.axiom.co/v1/datasets/$AXIOM_DATASET/ingest" >/dev/null

printf '%s\n' "$health" > "$state/health"
if [[ -s $state/entries ]]; then
  tail -n 1 "$state/entries" | jq -r .__CURSOR > "$state/cursor.new"
  mv "$state/cursor.new" "$state/cursor"
fi

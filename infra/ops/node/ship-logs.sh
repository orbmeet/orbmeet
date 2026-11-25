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
trap 'rm -f "$state/entries" "$state/chunk" "$state/batch" "$state/cursor.new" "$state/health.new" "$state/auth"' EXIT

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

# The health check's latest result in a set of entries: its PASS or FAIL line,
# or, for a run of the check that printed neither, systemd's word that it did
# not finish. A check killed at its timeout (Docker hanging) or dying before it
# could say why prints nothing of its own, and must not read as the last PASS;
# one that failed and said why also exits non-zero, and systemd's line after
# it must not replace the reason with its own. A run of the check starts with
# systemd's "Starting" line, so what it said is forgotten there.
health_line() {
  jq -rn '
    reduce inputs as $entry ({line: null, said: false};
      ($entry.MESSAGE | if type == "string" then . else "" end) as $message
      | if $entry.SYSLOG_IDENTIFIER == "orbmeet-health"
          and ($message | startswith("PASS") or startswith("FAIL")) then
          {line: $message, said: true}
        elif $entry.UNIT == "orbmeet-health.service" and ($message | startswith("Starting")) then
          .said = false
        elif $entry.UNIT == "orbmeet-health.service" and ($message | test("Failed with result")) then
          if .said then .said = false
          else {line: ("FAIL readiness: the check did not finish ("
            + ($message | capture("result .(?<why>[a-z-]+).") .why) + ")"), said: false} end
        else . end)
    | .line // empty' "$1"
}
previous=$(cat "$state/health" 2>/dev/null || echo PASS)
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

# Sends one request's entries, with the health check's result when they
# change it, and the heartbeat when the request closes the run ($2 = last).
# What a request delivered is recorded once it lands, and together: how far
# the journal was read, and the health that reading reported. A later request
# that fails leaves both where this one put them, so the next run neither
# sends these entries again nor misses the change they made.
deliver() {
  local latest health
  latest=$(health_line "$1")
  health=${latest%% *}
  health=${health:-$previous}
  jq -nc --arg node "$NODE" -f /usr/local/lib/orbmeet/ship-logs.jq "$1" > "$state/batch"
  if [[ $health != "$previous" ]]; then
    jq -nc --arg node "$NODE" --arg time "$now" --arg line "$latest" \
      '{_time: $time, source: "node", node: $node, service: "health",
        level: (if ($line | startswith("FAIL")) then "error" else "info" end), msg: $line}' >> "$state/batch"
  fi
  if [[ $2 == last ]]; then
    jq -nc --arg node "$NODE" --arg time "$now" --argjson healthy "$([[ $health == PASS ]] && echo true || echo false)" \
      '{_time: $time, source: "node", node: $node, service: "shipper", level: "info", msg: "heartbeat", healthy: $healthy}' \
      >> "$state/batch"
  fi
  post "$state/batch"
  if [[ -s $1 ]]; then
    tail -n 1 "$1" | jq -r .__CURSOR > "$state/cursor.new"
    mv "$state/cursor.new" "$state/cursor"
  fi
  printf '%s\n' "$health" > "$state/health.new"
  mv "$state/health.new" "$state/health"
  previous=$health
}

# Sent in chunks, each recorded as it lands: a backlog from an outage goes as
# several requests, each small enough to land, rather than as one that grows
# with every failed run until none ever can. A chunk ends only after a line
# that leaves no line Docker wrote in parts unfinished, so all of a line's
# parts go in one request whatever other entries come between them; and the
# run's last line always ends one. Each chunk is printed as "first last".
chunks=$(jq -rn --argjson size "${SHIP_LOGS_CHUNK_LINES:-2000}" '
  def chunks($ends; $from):
    if $from > ($ends | last) then empty
    else (([$ends[] | select(. >= $from and . < $from + $size)] | last)
          // ([$ends[] | select(. >= $from)] | first)) as $to
      | "\($from) \($to)", chunks($ends; $to + 1)
    end;
  reduce inputs as $entry ({line: 0, open: {}, ends: []};
    .line += 1
    | ($entry.CONTAINER_PARTIAL_ID) as $id
    | if $id == null then .
      elif $entry.CONTAINER_PARTIAL_LAST == "true" then del(.open[$id])
      else .open[$id] = true end
    | if .open == {} then .ends += [.line] else . end)
  | if .line == 0 then empty
    else (.ends + (if (.ends | last) == .line then [] else [.line] end)) as $ends | chunks($ends; 1) end' \
  "$state/entries")
total=$(wc -l < "$state/entries" | tr -d ' ')
if [[ -z $chunks ]]; then
  : > "$state/chunk"
  deliver "$state/chunk" last
fi
while read -r first last; do
  [[ -n $first ]] || continue
  sed -n "${first},${last}p" "$state/entries" > "$state/chunk"
  deliver "$state/chunk" "$( (( last == total )) && echo last || echo more)"
done <<< "$chunks"

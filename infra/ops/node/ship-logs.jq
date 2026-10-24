# A run's journal entries (journalctl -o json --all) in; the events
# ship-logs.sh sends to Axiom out. What is kept is what goes wrong, not what
# goes on:
#
# - warnings and errors from our services (whiteboard, transcription), and
#   whatever they print that is not a log line (a crash);
# - LiveKit's errors. Its warnings are mostly clients going away, and its
#   participants' comings and goings are in the Worker's log already, from
#   its webhooks, with LiveKit's reason;
# - the kernel killing a process for memory, and the node booting.
#
# The health check's results are ship-logs.sh's to report, as they change.
#
# Every event has the same few fields. Axiom gives a dataset a fixed number
# of fields (256 on the free plan) and refuses events past it, so whatever
# else a line says travels as one JSON string, `detail`, which a query reads
# with parse_json.
#
# Run with -n --arg node <name>.

def message:
  if (.MESSAGE | type) == "string" then .MESSAGE
  else (.MESSAGE // [] | implode) end;

# Docker writes a line over 16K to the journal in parts, each naming the line
# (CONTAINER_PARTIAL_ID), its place in it and whether it is the last. A part
# alone is not a log line, and read as one it would be a crash; so the parts
# become the one entry they are, at the last. ship-logs.sh holds back a line
# still being written, so one unfinished at the end has been given up on, and
# goes as far as it got. A line whose first part was in an earlier run is
# dropped: only a journal read from the middle (a node's first run) begins
# with the rest of one.
def joined:
  if .[0].CONTAINER_PARTIAL_ORDINAL == "1" then .[0] + {MESSAGE: (map(message) | add)} else empty end;

def whole_entries(entries):
  foreach (entries, null) as $entry ({parts: {}};
    ($entry.CONTAINER_PARTIAL_ID) as $id
    | if $entry == null then .whole = [.parts[] | joined]
      elif $id == null then .whole = [$entry]
      else .parts[$id] += [$entry]
        | if $entry.CONTAINER_PARTIAL_LAST == "true" then
            .whole = [.parts[$id] | joined] | del(.parts[$id])
          else .whole = [] end
      end;
    .whole[]);

# Axiom's _time, to the millisecond.
def time:
  (.__REALTIME_TIMESTAMP | tonumber) as $us
  | ($us / 1000000 | floor | strftime("%Y-%m-%dT%H:%M:%S"))
    + "." + (($us / 1000 | floor) % 1000 | tostring | "00\(.)" | .[-3:]) + "Z";

def level_name:
  if type == "number" then (if . >= 50 then "error" elif . >= 40 then "warn" else "info" end)
  else ascii_downcase end;

def failing: IN("error", "dpanic", "panic", "fatal");

# What a LiveKit error names; the rest of its fields are its client's whole
# configuration and a stack.
def livekit_fields:
  {room, participant, error}
  | with_entries(select(.value != null))
  | if .room then . + {meetingId: (.room | ltrimstr("meet-"))} else . end;

def container_event($service):
  message as $text
  | ($text | try fromjson catch null) as $line
  | if ($line | type) == "object" then
      ($line.level | level_name) as $level
      | if $service == "livekit" then
          select($level | failing)
          | {level: $level, msg: $line.msg} + ($line | livekit_fields)
        else
          select(($level == "warn") or ($level | failing))
          | ($line | del(.ts, .time, .level, .msg, .pid, .hostname)) as $rest
          | {level: $level, msg: $line.msg}
            + (if $rest == {} then {} else {detail: ($rest | tojson)} end)
        end
    # Not a log line: on stderr, that is a crash or the runtime's own complaint.
    elif .PRIORITY == "3" and $text != "" then {level: "error", msg: $text}
    else empty end
  | . + {service: $service};

def event:
  if .CONTAINER_NAME then
    (.CONTAINER_NAME | capture("^orbmeet-\($node)-(?<service>[a-z]+)-[0-9]+$").service) as $service
    | select(IN($service; "whiteboard", "transcription", "livekit"))
    | container_event($service)
  elif ._TRANSPORT == "kernel" then
    message | select(test("Out of memory|oom-kill"; "i")) | {service: "kernel", level: "error", msg: .}
  elif .SYSLOG_IDENTIFIER == "systemd" and ._PID == "1" then
    message | select(startswith("Startup finished")) | {service: "boot", level: "info", msg: .}
  else empty end;

whole_entries(inputs) | (time) as $time | event | {_time: $time, source: "node", node: $node} + .

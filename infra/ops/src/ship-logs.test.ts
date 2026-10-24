import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_DIR } from "./catalog.ts";

// node/ship-logs.jq decides what of a node's journal reaches Axiom. It runs
// under the jq the node has; these run it under the operator's.

const at = "1791908966123456";

function ship(...entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const input = entries.map((entry) => JSON.stringify({ __REALTIME_TIMESTAMP: at, PRIORITY: "6", ...entry })).join("\n");
  const run = spawnSync("jq", ["-nc", "--arg", "node", "ams1", "-f", join(NODE_DIR, "ship-logs.jq")], { input });
  if (run.error) throw new Error(`These tests need jq: ${run.error.message}`);
  expect(run.stderr.toString()).toBe("");
  return run.stdout.toString().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const container = (service: string, message: unknown, priority = "3") => ({
  CONTAINER_NAME: `orbmeet-ams1-${service}-1`,
  PRIORITY: priority,
  MESSAGE: typeof message === "string" ? message : JSON.stringify(message),
});

describe("ship-logs.jq", () => {
  it("keeps LiveKit's errors, with the meeting they belong to, and nothing else it says", () => {
    const events = ship(
      container("livekit", { level: "info", msg: "participant closing", room: "meet-meeting_01", participant: "user_a" }),
      container("livekit", { level: "warn", msg: "error reading data channel", room: "meet-meeting_01" }),
      container("livekit", { level: "error", msg: "could not handle new participant", room: "meet-meeting_01",
        participant: "user_a", error: "could not restart participant", errorVerbose: "a long stack",
        clientInfo: { os: "iOS" } }),
    );
    expect(events).toEqual([
      { _time: "2026-10-13T16:29:26.123Z", source: "node", node: "ams1", service: "livekit", level: "error",
        msg: "could not handle new participant", room: "meet-meeting_01", participant: "user_a",
        error: "could not restart participant", meetingId: "meeting_01" },
    ]);
  });

  it("keeps our services' warnings, errors and crashes, their own fields folded into one", () => {
    const events = ship(
      container("whiteboard", { ts: "t", level: "error", msg: "[room] save failed", roomId: "r1", args: [{ name: "Error" }] }),
      container("whiteboard", { ts: "t", level: "info", msg: "[whiteboard] listening" }, "6"),
      container("transcription", { level: 40, time: 1, pid: 7, hostname: "h", msg: "deepgram slow" }),
      container("transcription", "TypeError: x is not a function"),
      container("transcription", "plain output", "6"),
    );
    expect(events.map(({ service, level, msg, detail }) => ({ service, level, msg, detail }))).toEqual([
      { service: "whiteboard", level: "error", msg: "[room] save failed",
        detail: JSON.stringify({ roomId: "r1", args: [{ name: "Error" }] }) },
      { service: "transcription", level: "warn", msg: "deepgram slow", detail: undefined },
      { service: "transcription", level: "error", msg: "TypeError: x is not a function", detail: undefined },
    ]);
  });

  it("reads a line Docker wrote in parts as the one line it is", () => {
    const line = JSON.stringify({ level: "error", msg: "could not handle new participant", room: "meet-meeting_01",
      sdp: "a=ice-options:trickle ".repeat(1000) });
    const part = (id: string, ordinal: number, last: boolean, message: string) => ({
      ...container("livekit", message), CONTAINER_PARTIAL_MESSAGE: last ? undefined : "true",
      CONTAINER_PARTIAL_ID: id, CONTAINER_PARTIAL_ORDINAL: String(ordinal), CONTAINER_PARTIAL_LAST: String(last),
    });
    const events = ship(
      part("p1", 1, false, line.slice(0, 16384)),
      container("livekit", { level: "info", msg: "between the parts" }),
      part("p1", 2, true, line.slice(16384)),
      // The rest of a line whose first part an earlier run read: not a crash.
      part("p0", 2, true, "a=rtcp-fb:120 nack"),
    );
    expect(events.map(({ service, level, msg, meetingId }) => ({ service, level, msg, meetingId }))).toEqual([
      { service: "livekit", level: "error", msg: "could not handle new participant", meetingId: "meeting_01" },
    ]);
  });

  it("sends nothing for an empty line on stderr", () => {
    expect(ship(container("livekit", ""), { ...container("transcription", ""), MESSAGE: null })).toEqual([]);
  });

  it("keeps out-of-memory kills and boots, and leaves health results to the script", () => {
    const events = ship(
      { SYSLOG_IDENTIFIER: "orbmeet-health", MESSAGE: "PASS ams1: host policy" },
      { SYSLOG_IDENTIFIER: "orbmeet-health", MESSAGE: "FAIL readiness: livekit is unhealthy" },
      { _TRANSPORT: "kernel", MESSAGE: "Out of memory: Killed process 1234 (node)" },
      { _TRANSPORT: "kernel", MESSAGE: "eth0: link up" },
      { SYSLOG_IDENTIFIER: "systemd", _PID: "1", MESSAGE: "Startup finished in 13.2s." },
      { SYSLOG_IDENTIFIER: "systemd", _PID: "1", MESSAGE: "Started orbmeet-health.service." },
      container("caddy", { level: "error", msg: "matching connection" }),
      { CONTAINER_NAME: "orbmeet-sg1-whiteboard-1", PRIORITY: "3", MESSAGE: "another node's container" },
    );
    expect(events.map(({ service, level }) => [service, level])).toEqual([["kernel", "error"], ["boot", "info"]]);
  });
});

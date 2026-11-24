import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NODE_DIR } from "./catalog.ts";

// node/ship-logs.sh run against a scripted journal and Axiom: its paths
// moved into a directory of its own, journalctl and curl stood in for.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ship-logs-"));
  writeFileSync(join(dir, "host.env"), "NODE=ams1\nAXIOM_TOKEN=tok\nAXIOM_DATASET=orbmeet\n");
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub("journalctl", `printf '%s\\n' "$*" >> "${dir}/journalctl-args"; cat "${dir}/journal"`);
  // Each request's body in a file of its own, in order; its arguments, and
  // the header file it was pointed at, alongside.
  stub("curl", [
    `n=$(( $(cat "${dir}/post-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${dir}/post-count"`,
    `printf '%s\\n' "$*" >> "${dir}/curl-args"`,
    `for arg in "$@"; do [[ $arg == @* && $arg != @- ]] && cat "\${arg#@}" >> "${dir}/curl-headers"; done`,
    `cat > "${dir}/post-$n"`,
    `failing=$(cat "${dir}/curl-fail-at" 2>/dev/null || echo 0); [[ $n == "$failing" ]] && exit 7`,
    `exit "$(cat "${dir}/curl-exit" 2>/dev/null || echo 0)"`,
  ].join("\n"));
  const script = readFileSync(join(NODE_DIR, "ship-logs.sh"), "utf8")
    .replace("/etc/orbmeet/host.env", join(dir, "host.env"))
    .replace("/var/lib/orbmeet/ship-logs", join(dir, "state"))
    .replace("/usr/local/lib/orbmeet/ship-logs.jq", join(NODE_DIR, "ship-logs.jq"));
  writeFileSync(join(dir, "ship-logs.sh"), script);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

let cursor = 0;
const health = (message: string) =>
  JSON.stringify({ __CURSOR: `c${++cursor}`, __REALTIME_TIMESTAMP: "1791908966123456", SYSLOG_IDENTIFIER: "orbmeet-health", MESSAGE: message });

const posts = () => (existsSync(join(dir, "post-count")) ? Number(readFileSync(join(dir, "post-count"), "utf8")) : 0);

/** One run over these journal lines; what it sent (every request, in order), and how it exited. */
function run(...lines: string[]): { status: number | null; sent: Sent[]; requests: number } {
  return runWith({}, ...lines);
}

function runWith(env: Record<string, string>, ...lines: string[]): { status: number | null; sent: Sent[]; requests: number } {
  writeFileSync(join(dir, "journal"), lines.map((line) => `${line}\n`).join(""));
  const before = posts();
  const result = spawnSync("bash", [join(dir, "ship-logs.sh")], {
    env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}` },
  });
  if (result.error) throw result.error;
  const sent: Sent[] = [];
  for (let n = before + 1; n <= posts(); n++) sent.push(...JSON.parse(readFileSync(join(dir, `post-${n}`), "utf8")));
  return { status: result.status, sent, requests: posts() - before };
}

interface Sent { service: string; level: string; msg: string; healthy?: boolean }

const summary = (sent: Sent[]) => sent.map(({ service, level, msg, healthy }) =>
  service === "shipper" ? `heartbeat healthy=${String(healthy)}` : `${service} ${level}: ${msg}`);

describe("ship-logs.sh", () => {
  it("sends a heartbeat every run, and the health check's result only when it changes", () => {
    expect(summary(run(health("PASS ams1: ok")).sent)).toEqual(["heartbeat healthy=true"]);
    expect(summary(run(health("PASS ams1: ok"), health("FAIL readiness: livekit is unhealthy")).sent)).toEqual([
      "health error: FAIL readiness: livekit is unhealthy",
      "heartbeat healthy=false",
    ]);
    expect(summary(run(health("FAIL readiness: livekit is unhealthy")).sent)).toEqual(["heartbeat healthy=false"]);
    expect(summary(run().sent)).toEqual(["heartbeat healthy=false"]);
    expect(summary(run(health("PASS ams1: ok")).sent)).toEqual(["health info: PASS ams1: ok", "heartbeat healthy=true"]);
  });

  it("resumes after the last entry it delivered, and sends again what it could not", () => {
    run(health("PASS ams1: ok"));
    writeFileSync(join(dir, "curl-exit"), "7");
    const failed = run(health("FAIL readiness: livekit is unhealthy"));
    expect(failed.status).not.toBe(0);
    writeFileSync(join(dir, "curl-exit"), "0");
    expect(summary(run(health("FAIL readiness: livekit is unhealthy")).sent)).toContain(
      "health error: FAIL readiness: livekit is unhealthy",
    );
    const args = readFileSync(join(dir, "journalctl-args"), "utf8").trim().split("\n");
    expect(args[0]).toContain("--since=-15min");
    // Without --all, a field over 4096 bytes reads as null.
    expect(args.every((line) => line.includes("--all"))).toBe(true);
    // The failed run's entries were not counted as read: both later runs resume after the first.
    expect(args[1]).toContain(`--after-cursor=c${cursor - 2}`);
    expect(args[2]).toContain(`--after-cursor=c${cursor - 2}`);
  });

  it("leaves a line still being written in parts to the next run, and sends it whole", () => {
    const line = JSON.stringify({ level: "error", msg: "could not handle new participant" });
    const part = (ordinal: number, last: boolean, message: string, at = Date.now() * 1000) => JSON.stringify({
      __CURSOR: `c${++cursor}`, __REALTIME_TIMESTAMP: String(at), CONTAINER_NAME: "orbmeet-ams1-livekit-1",
      PRIORITY: "3", MESSAGE: message, CONTAINER_PARTIAL_ID: `p${ordinal === 1 ? cursor : cursor - 1}`,
      CONTAINER_PARTIAL_ORDINAL: String(ordinal), CONTAINER_PARTIAL_LAST: String(last),
    });
    const before = health("PASS ams1: ok");
    const first = part(1, false, line.slice(0, 20));
    expect(summary(run(before, first).sent)).toEqual(["heartbeat healthy=true"]);

    const rest = part(2, true, line.slice(20));
    expect(summary(run(first, rest).sent)).toEqual(["livekit error: could not handle new participant", "heartbeat healthy=true"]);
    const args = readFileSync(join(dir, "journalctl-args"), "utf8").trim().split("\n");
    expect(args[1]).toContain(`--after-cursor=${JSON.parse(before).__CURSOR}`);

    // A line whose last part is long overdue is not waited for.
    const stale = part(1, false, "TypeError: half a line", Date.now() * 1000 - 120_000_000);
    expect(summary(run(stale).sent)).toEqual(["livekit error: TypeError: half a line", "heartbeat healthy=true"]);
  });

  it("reports a check that did not finish as failing, however it last passed", () => {
    expect(summary(run(health("PASS ams1: ok")).sent)).toEqual(["heartbeat healthy=true"]);
    // Docker hung: systemd killed the check at its timeout, before it could print.
    const killed = JSON.stringify({
      __CURSOR: `c${++cursor}`, __REALTIME_TIMESTAMP: "1791908966123456", SYSLOG_IDENTIFIER: "systemd",
      UNIT: "orbmeet-health.service", MESSAGE: "orbmeet-health.service: Failed with result 'timeout'.",
    });
    expect(summary(run(killed).sent)).toEqual([
      "health error: FAIL readiness: the check did not finish (timeout)",
      "heartbeat healthy=false",
    ]);
  });

  it("keeps the Axiom token off curl's command line", () => {
    run(health("PASS ams1: ok"));
    expect(readFileSync(join(dir, "curl-args"), "utf8")).not.toContain("tok");
    expect(readFileSync(join(dir, "curl-headers"), "utf8")).toContain("Authorization: Bearer tok");
  });

  it("sends a backlog in chunks, keeping what each delivered when a later one fails", () => {
    const crash = (index: number) => JSON.stringify({
      __CURSOR: `c${++cursor}`, __REALTIME_TIMESTAMP: "1791908966123456", CONTAINER_NAME: "orbmeet-ams1-whiteboard-1",
      PRIORITY: "3", MESSAGE: `crash ${index}`,
    });
    const lines = Array.from({ length: 5 }, (_, index) => crash(index));
    writeFileSync(join(dir, "curl-fail-at"), "2");
    const failed = runWith({ SHIP_LOGS_CHUNK_LINES: "2" }, ...lines);
    expect(failed.status).not.toBe(0);
    expect(failed.requests).toBe(2);

    // The first chunk landed and is not sent again.
    writeFileSync(join(dir, "curl-fail-at"), "0");
    const resumed = runWith({ SHIP_LOGS_CHUNK_LINES: "2" }, ...lines.slice(2));
    expect(resumed.requests).toBe(2);
    expect(resumed.sent.filter((event) => event.service !== "shipper").map((event) => event.msg))
      .toEqual(["crash 2", "crash 3", "crash 4"]);
    const args = readFileSync(join(dir, "journalctl-args"), "utf8").trim().split("\n");
    expect(args[1]).toContain(`--after-cursor=${JSON.parse(lines[1]).__CURSOR}`);
  });
});

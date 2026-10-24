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
  stub("curl", `cat >> "${dir}/posts"; echo >> "${dir}/posts"; exit "$(cat "${dir}/curl-exit" 2>/dev/null || echo 0)"`);
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

/** One run over these journal lines; what it sent, and how it exited. */
function run(...lines: string[]): { status: number | null; sent: Sent[] } {
  writeFileSync(join(dir, "journal"), lines.map((line) => `${line}\n`).join(""));
  const before = existsSync(join(dir, "posts")) ? readFileSync(join(dir, "posts"), "utf8").length : 0;
  const result = spawnSync("bash", [join(dir, "ship-logs.sh")], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  if (result.error) throw result.error;
  const posted = existsSync(join(dir, "posts")) ? readFileSync(join(dir, "posts"), "utf8").slice(before).trim() : "";
  return { status: result.status, sent: posted ? JSON.parse(posted) : [] };
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
});

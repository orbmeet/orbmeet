// Runs the browser smoke tests: `pnpm e2e [playwright args]`.
//
// It prepares a fresh stack before Playwright starts its servers: a wiped state
// dir, the Worker's `.dev.vars.e2e`, and a migrated local D1. It may share a
// media node with live meetings, so it keeps out of their way: its LiveKit
// runs on ports of its own, capped at one CPU (playwright.config.ts), and the
// whole suite runs at low CPU priority so live meetings come first.
import { spawn, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { LIVEKIT_CONTAINER, RUN_DIR, WEB_DIR, WEB_VARS } from "./stack.ts";
import { databaseId } from "../build/config/worker-target.ts";

const STATE_DIR = `${WEB_DIR}.cloudflare/e2e-state`;
const MIGRATIONS_DIR = `${WEB_DIR}../../packages/db/drizzle/migrations`;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: WEB_DIR, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function writeDevVars() {
  // Single quotes: dotenv takes their contents literally, JSON included.
  const lines = Object.entries(WEB_VARS).map(([name, value]) => `${name}='${value}'`);
  writeFileSync(`${WEB_DIR}.dev.vars.e2e`, `${lines.join("\n")}\n`);
}

/** The JSON report `cf d1 migrations apply` prints, once all of it has arrived. */
function parseMigrationReport(output: string): { status: string }[] | null {
  const start = output.indexOf("\n[");
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start)) as { status: string }[];
  } catch {
    return null;
  }
}

/**
 * Applies the migrations to the simulated D1 in STATE_DIR (`--local`). `cf`
 * sometimes stays up after printing its report, so the report decides, and
 * `cf` is stopped once it has arrived.
 */
async function migrateLocalD1() {
  // The simulated database is keyed by this id, as the Vite plugin keys it.
  if (!databaseId) throw new Error("cloudflare.deploy.json has no D1 database id; see its .example.");
  const child = spawn(
    "pnpm",
    [
      "exec", "cf", "d1", "migrations", "apply", databaseId,
      "--local",
      "--persist-to", STATE_DIR,
      "--dir", MIGRATIONS_DIR,
      "--pattern", `${MIGRATIONS_DIR}/*/migration.sql`,
    ],
    { cwd: WEB_DIR, detached: true },
  );
  child.stdin.end();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk));
  const report = await new Promise<{ status: string }[] | null>((resolve) => {
    const finish = () => {
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(parseMigrationReport(output));
    };
    const deadline = setTimeout(finish, 60_000);
    const poll = setInterval(() => parseMigrationReport(output) && finish(), 200);
    child.on("exit", finish);
  });
  // Detached, so this reaches cf itself and not just pnpm.
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
  if (!report || report.length === 0 || report.some((migration) => migration.status !== "✅")) {
    throw new Error(`Local D1 migrations failed:\n${output}`);
  }
}

/**
 * LiveKit drains its rooms on SIGTERM rather than exiting, so the container
 * Playwright started can outlive the run; it is removed on both sides of one.
 */
function removeLiveKit() {
  spawnSync("docker", ["rm", "-f", LIVEKIT_CONTAINER], { stdio: "ignore" });
}

try {
  removeLiveKit();
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(RUN_DIR, { recursive: true, force: true });
  writeDevVars();
  await migrateLocalD1();
  run("node", ["scripts/setup-assets.mjs", "prepare"]);
} catch (error) {
  console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const result = spawnSync(
  "nice",
  ["-n", "10", "pnpm", "exec", "playwright", "test", ...process.argv.slice(2)],
  { cwd: WEB_DIR, stdio: "inherit" },
);
removeLiveKit();
process.exit(result.status ?? 1);

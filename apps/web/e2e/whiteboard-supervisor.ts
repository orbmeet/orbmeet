// Runs the whiteboard server for the smoke tests and starts it again whenever
// it exits, the way the node's container restarts. A test restarts the server
// by sending SIGTERM to the pid in WHITEBOARD_PID_FILE (see support.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import { RUN_DIR, WHITEBOARD_DIR, WHITEBOARD_ENV, WHITEBOARD_PID_FILE } from "./stack.ts";

let child: ChildProcess | undefined;
let stopping = false;

function start() {
  // The developer's `.env`, when there is one, configures the board assistant
  // the Orb tests use; everything else this stack sets is in WHITEBOARD_ENV,
  // which takes precedence over the file.
  child = spawn(process.execPath, ["--env-file-if-exists=.env", "src/index.ts"], {
    cwd: WHITEBOARD_DIR,
    env: { ...process.env, ...WHITEBOARD_ENV },
    stdio: "inherit",
  });
  writeFileSync(WHITEBOARD_PID_FILE, String(child.pid));
  child.on("exit", () => {
    if (!stopping) setTimeout(start, 250);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    child?.kill("SIGTERM");
    process.exit(0);
  });
}

mkdirSync(RUN_DIR, { recursive: true });
start();

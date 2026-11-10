#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { exitForError, runCommand } from "./lib/run-command.mjs";

const web = new URL("..", import.meta.url);

// Vite's own entry point, run by this Node. Spawning `pnpm` would need a
// shell on Windows, where it is a `.cmd` shim that Node will not start
// directly; resolving the bin works the same everywhere.
const require = createRequire(import.meta.url);
const vitePackage = require.resolve("vite/package.json");
const vite = join(dirname(vitePackage), require(vitePackage).bin.vite);
const action = process.argv[2];

if (action !== "dev" && action !== "build") {
  console.error("Usage: node apps/web/scripts/web.mjs <dev|build>");
  process.exit(1);
}

try {
  runCommand(process.execPath, ["scripts/setup-assets.mjs", "prepare"], { cwd: web });

  if (action === "dev") {
    runCommand(process.execPath, ["scripts/setup-livekit.mjs"], { cwd: web });
    runCommand(process.execPath, [vite, "dev", "--port", "3000"], { cwd: web });
    process.exit(0);
  }

  runCommand(process.execPath, [vite, "build"], { cwd: web });
  runCommand(process.execPath, ["scripts/build-service-worker.mjs"], { cwd: web });
  runCommand(process.execPath, ["scripts/check-web-build.mjs"], { cwd: web });
} catch (error) {
  exitForError("web", error);
}

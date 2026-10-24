#!/usr/bin/env node

import process from "node:process";
import { exitForError, runCommand } from "./lib/run-command.mjs";

const web = new URL("..", import.meta.url);
const action = process.argv[2];

if (action !== "dev" && action !== "build") {
  console.error("Usage: node apps/web/scripts/web.mjs <dev|build>");
  process.exit(1);
}

try {
  runCommand(process.execPath, ["scripts/setup-assets.mjs", "prepare"], { cwd: web });

  if (action === "dev") {
    runCommand(process.execPath, ["scripts/setup-livekit.mjs"], { cwd: web });
    runCommand("pnpm", ["exec", "vite", "dev", "--port", "3000"], { cwd: web });
    process.exit(0);
  }

  runCommand("pnpm", ["exec", "vite", "build"], { cwd: web });
  runCommand(process.execPath, ["scripts/build-service-worker.mjs"], { cwd: web });
  runCommand(process.execPath, ["scripts/check-web-build.mjs"], { cwd: web });
} catch (error) {
  exitForError("web", error);
}

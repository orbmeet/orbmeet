import { spawnSync } from "node:child_process";
import process from "node:process";

class CommandError extends Error {
  constructor(message, exitCode = 1, options) {
    super(message, options);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
  });
  const display = [command, ...args].join(" ");

  if (result.error) {
    throw new CommandError(`Could not start ${display}: ${result.error.message}`, 1, {
      cause: result.error,
    });
  }
  if (result.signal) {
    throw new CommandError(`${display} terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new CommandError(`${display} failed with exit code ${result.status}`, result.status ?? 1);
  }
}

export function exitForError(scope, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${scope}] ${message}`);
  process.exit(error instanceof CommandError ? error.exitCode : 1);
}

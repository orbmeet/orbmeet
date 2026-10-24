import { spawn } from "node:child_process";
import { ROOT } from "./catalog.ts";

/** A failure the tool reports as one line, without a stack: its messages never carry secret values. */
export class OpsError extends Error {}

export interface RunOptions {
  cwd?: string;
  /** Return stdout instead of passing it through to the terminal. */
  capture?: boolean;
  /** Written to the command's stdin; secrets travel this way, never in argv. */
  input?: string;
  /** Hold all output back, and show its tail only if the command fails: for work run in parallel. */
  quiet?: boolean;
}

/** Runs a command to completion and rejects with OpsError when it fails. */
export type Shell = (args: readonly string[], options?: RunOptions) => Promise<string>;

export const shell: Shell = (args, { cwd = ROOT, capture = false, input, quiet = false } = {}) =>
  new Promise((resolve, reject) => {
    const [command, ...rest] = args;
    const child = spawn(command, rest, {
      cwd,
      stdio: [input !== undefined ? "pipe" : quiet ? "ignore" : "inherit",
        capture || quiet ? "pipe" : "inherit", quiet ? "pipe" : "inherit"],
    });
    let stdout = "";
    let held = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (capture) stdout += chunk;
      if (quiet) held += chunk;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      held += chunk;
    });
    if (input !== undefined) child.stdin?.end(input);
    child.on("error", (error) => reject(new OpsError(`${command}: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(capture ? stdout : "");
      const tail = quiet ? `\n${held.trimEnd().split("\n").slice(-40).join("\n")}` : "";
      reject(new OpsError(`Command failed (${code ?? signal}): ${args.join(" ")}${tail}`));
    });
  });

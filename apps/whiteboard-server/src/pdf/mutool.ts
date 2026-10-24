import { spawn, type ChildProcess } from "node:child_process";
import { type EventEmitter, once } from "node:events";

/**
 * How the PDF pipeline starts mutool. It is the one seam the tests replace
 * (test/pdf-doubles.ts) with a scripted mutool whose timing they control;
 * everything else in the pipeline runs as in production.
 */
export type MutoolProcess = EventEmitter & Pick<ChildProcess, "stdout" | "stderr" | "kill">;

export function spawnMutool(
  args: string[],
  output: { stdout: "pipe" | "ignore"; stderr: "pipe" | "ignore" },
): MutoolProcess {
  return spawn("mutool", args, { stdio: ["ignore", output.stdout, output.stderr] });
}

/**
 * The process's exit code once it has exited and its output has closed; a
 * process killed by a signal counts as a failure. Rejects if mutool could not
 * be started at all.
 *
 * Call it as soon as the process is spawned, before any await, so the event
 * cannot be missed.
 */
export async function mutoolExited(proc: MutoolProcess): Promise<number> {
  const [code] = await once(proc, "close") as [number | null, NodeJS.Signals | null];
  return code ?? 1;
}

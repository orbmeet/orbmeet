import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logWarn } from "./log.js";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Write complete JSON atomically and clean up failures before returning. */
export function writeJsonFileAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  let temporaryFd: number | null = null;
  let renamed = false;
  try {
    temporaryFd = openSync(temporaryPath, "w", 0o600);
    writeFileSync(temporaryFd, JSON.stringify(value), { encoding: "utf8" });
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    temporaryFd = null;
    renameSync(temporaryPath, path);
    renamed = true;
    try {
      const directoryFd = openSync(dirname(path), "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch (error) {
      // The complete file has already replaced the target. Surface the weaker
      // crash-durability guarantee without reporting the write as absent.
      logWarn(`Failed to fsync directory after writing ${path}:`, error);
    }
  } finally {
    if (temporaryFd !== null) closeSync(temporaryFd);
    if (!renamed) rmSync(temporaryPath, { force: true });
  }
}

/** Remove atomic-write remnants belonging to processes that no longer exist. */
export function reapOrphanedAtomicWriteFiles(
  directory: string,
  names: string[],
): void {
  for (const name of names) {
    const pidText = /\.(\d+)\.tmp$/.exec(name)?.[1]
      ?? /-(\d+)\.json\.tmp$/.exec(name)?.[1];
    if (!pidText) continue;
    const pid = Number(pidText);
    if (Number.isSafeInteger(pid) && pid > 0 && !processIsAlive(pid)) {
      try {
        rmSync(join(directory, name), { force: true });
      } catch {
        // Another healthcheck may have removed the same orphan first.
      }
    }
  }
}

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { errorMessage } from "../error-message.js";
import {
  reapOrphanedAtomicWriteFiles,
  writeJsonFileAtomic,
} from "../atomic-json-file.js";
import { logError } from "../log.js";

const CONNECTION_STATUS_DIR = "/tmp/orbmeet-transcription-connections";
// Longest intentional recovery step is a 30s backoff followed by a 12s open
// deadline. Readiness should kill only a stalled step, not a healthy retry.
const CONNECTION_OPEN_GRACE_MS = 50_000;
// A status stamped ahead of the reader's clock by more than this did not come
// from a connection that is still opening. Small amounts are ordinary
// coarse-clock noise; a large one means the writer's clock moved, and
// `now - updatedAt` then stays negative forever — a stalled connect that the
// grace period could never expire.
const CONNECTION_CLOCK_SKEW_TOLERANCE_MS = 5_000;

export type TranscriptionConnectionPhase = "connecting" | "connected" | "failed";

export interface TranscriptionConnectionStatus {
  id: string;
  phase: TranscriptionConnectionPhase;
  pid: number;
  processStartTicks?: string;
  updatedAt: string;
  message?: string;
  /**
   * Cumulative transcript results on this connection that will never be
   * persisted (refused at the serial result queue's bound, or arrival without
   * a resolvable capture timestamp). Telemetry, not readiness: the words are
   * already lost, and restarting the container would shed the rest of the
   * meeting without recovering them.
   */
  droppedResults?: number;
  lastDropReason?: string;
}

function statusPath(id: string): string {
  if (!/^[0-9A-Za-z-]+$/.test(id)) throw new Error("invalid transcription connection id");
  return `${CONNECTION_STATUS_DIR}/${id}.json`;
}

/** Linux /proc field 22 uniquely identifies a particular use of a PID. */
function readProcessStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    return stat.slice(commandEnd + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

export function recordTranscriptionConnectionStatus(
  id: string,
  phase: TranscriptionConnectionPhase,
  error?: unknown,
): void {
  try {
    const processStartTicks = readProcessStartTicks(process.pid);
    const status: TranscriptionConnectionStatus = {
      id,
      phase,
      pid: process.pid,
      ...(processStartTicks ? { processStartTicks } : {}),
      updatedAt: new Date().toISOString(),
      ...(error === undefined ? {} : { message: errorMessage(error) }),
    };
    // Phase writes rebuild the file from connection state, so carry any loss
    // counter forward: a reconnect mid-meeting must not reset the only
    // aggregate record of results this connection already refused.
    const previous = readStatusFile(id);
    if (previous?.droppedResults !== undefined) {
      status.droppedResults = previous.droppedResults;
      status.lastDropReason = previous.lastDropReason;
    }
    mkdirSync(CONNECTION_STATUS_DIR, { recursive: true, mode: 0o700 });
    const path = statusPath(id);
    writeJsonFileAtomic(path, status);
  } catch (recordError) {
    // Readiness telemetry must never replace the connection outcome it records.
    logError("Failed to record transcription connection status", recordError);
  }
}

function readStatusFile(id: string): TranscriptionConnectionStatus | null {
  try {
    return parseStatus(readFileSync(statusPath(id), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Count a transcript result that will never be persisted on this connection.
 *
 * The drop is loudly logged where it happens; this adds the running total to
 * the connection's status file so it is visible beside the phase without
 * trawling container logs. Best effort: once the connection has closed (file
 * removed) there is nothing to attach the count to, and the log line is the
 * durable record.
 */
export function recordTranscriptionResultLoss(id: string, reason: string): void {
  try {
    const previous = readStatusFile(id);
    if (!previous) return;
    const status: TranscriptionConnectionStatus = {
      ...previous,
      droppedResults: (previous.droppedResults ?? 0) + 1,
      lastDropReason: reason.slice(0, 200),
      updatedAt: new Date().toISOString(),
    };
    writeJsonFileAtomic(statusPath(id), status);
  } catch (recordError) {
    logError("Failed to record transcription result loss", recordError);
  }
}

export function removeTranscriptionConnectionStatus(id: string): void {
  try {
    rmSync(statusPath(id), { force: true });
  } catch (removeError) {
    // Cleanup telemetry is best effort for the same reason writes are.
    logError("Failed to remove transcription connection status", removeError);
  }
}

function parseStatus(value: string): TranscriptionConnectionStatus | null {
  try {
    const status = JSON.parse(value) as Partial<TranscriptionConnectionStatus>;
    if (
      typeof status.id !== "string" ||
      (status.phase !== "connecting" && status.phase !== "connected" && status.phase !== "failed") ||
      typeof status.pid !== "number" ||
      !Number.isInteger(status.pid) ||
      status.pid <= 0 ||
      (status.processStartTicks !== undefined && typeof status.processStartTicks !== "string") ||
      typeof status.updatedAt !== "string" ||
      (status.message !== undefined && typeof status.message !== "string") ||
      (status.droppedResults !== undefined &&
        (!Number.isInteger(status.droppedResults) || status.droppedResults < 1)) ||
      (status.lastDropReason !== undefined && typeof status.lastDropReason !== "string")
    ) return null;
    return status as TranscriptionConnectionStatus;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readActiveTranscriptionConnectionStatuses(): TranscriptionConnectionStatus[] {
  let files: string[];
  try {
    files = readdirSync(CONNECTION_STATUS_DIR);
  } catch {
    return [];
  }
  reapOrphanedAtomicWriteFiles(CONNECTION_STATUS_DIR, files);

  const statuses: TranscriptionConnectionStatus[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = `${CONNECTION_STATUS_DIR}/${file}`;
    try {
      const status = parseStatus(readFileSync(filePath, "utf8"));
      // Final status writes are atomic; malformed JSON cannot be a partial
      // live write and would otherwise be reparsed on every healthcheck.
      if (!status) {
        rmSync(filePath, { force: true });
        continue;
      }
      const alive = processIsAlive(status.pid);
      const sameProcess = alive && (
        !status.processStartTicks ||
        readProcessStartTicks(status.pid) === status.processStartTicks
      );
      if (sameProcess) {
        statuses.push(status);
      } else {
        rmSync(filePath, { force: true });
      }
    } catch {
      // A job can remove its status while the healthcheck is reading the directory.
    }
  }
  return statuses;
}

/**
 * Whether one participant's Deepgram connection is not working.
 *
 * This is a *job-level* verdict and deliberately not a container-level one. It
 * describes one publisher job's connection to Deepgram: a stall past the open
 * grace, a clock that cannot be trusted, or a retry budget spent down to
 * `failed`. None of those is repaired by restarting the process — a rejected
 * API key or a refused upstream returns exactly the same way after a restart,
 * while every unrelated meeting sharing this container loses its captions. The
 * container's own Deepgram dependency is probed directly by the healthcheck
 * (`probeTls`), which is the signal a restart can actually act on.
 *
 * So callers report this; they do not fail readiness on it. Doing otherwise
 * turned a vendor outage into a restart loop: each cycle spends its retry
 * budget, records `failed`, waits out the backoff — and is killed mid-wait,
 * over and over, taking the whole host's transcription with it.
 */
export function isUnhealthyTranscriptionConnection(
  status: TranscriptionConnectionStatus,
  now = Date.now(),
): boolean {
  if (status.phase === "connected") return false;
  if (status.phase === "failed") return true;
  const updatedAt = Date.parse(status.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  if (updatedAt - now > CONNECTION_CLOCK_SKEW_TOLERANCE_MS) return true;
  return now - updatedAt > CONNECTION_OPEN_GRACE_MS;
}

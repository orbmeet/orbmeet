import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { meetingAdmissions, meetingConnections } from "@orbmeet/db/schema";
import type { MeetingConnectionStatus } from "@/modules/meetings/contract/constants";

/**
 * What a meeting connection's status means for the code that reads it. A row
 * is one connection attempt, projected by the meeting's MeetingRoom (the only
 * writer; see ../runtime/meeting-room.ts). Every question about a connection's state is
 * asked through one of these names; a boundary test forbids comparing
 * `connection_status` to a literal anywhere else.
 *
 * - **present**: LiveKit confirmed the participant is in the room (`live`).
 *   What people are shown: attendance, participant counts.
 * - **unfinished**: issued or present — the attempt holds its seat. A token
 *   that never reached the room stays issued only until the meeting's room
 *   looks and does not find it (../runtime/step.ts, `reconcilePresence`), so
 *   this is also what live-access checks (whiteboard) accept: an attempt
 *   LiveKit admitted is not refused because its join report was late or lost.
 * - **ended**: finished for the reason in `reason`.
 */

// ─── ended ───────────────────────────────────────────────────────────────────

export function connectionIsEnded(
  column: AnySQLiteColumn = meetingConnections.connectionStatus,
): SQL {
  return eq(column, "ended");
}

export function isEndedConnection(status: MeetingConnectionStatus): boolean {
  return status === "ended";
}

// ─── unfinished ──────────────────────────────────────────────────────────────

const UNFINISHED_CONNECTION_STATUSES = ["pending", "live"] as const;

export function connectionIsUnfinished(
  column: AnySQLiteColumn = meetingConnections.connectionStatus,
): SQL {
  return inArray(column, [...UNFINISHED_CONNECTION_STATUSES]);
}

/** In-memory twin of `connectionIsUnfinished`, for rows already loaded. */
export function isUnfinishedConnection(status: MeetingConnectionStatus): boolean {
  return (UNFINISHED_CONNECTION_STATUSES as readonly MeetingConnectionStatus[]).includes(status);
}

// ─── present ─────────────────────────────────────────────────────────────────

export function connectionIsPresent(
  column: AnySQLiteColumn = meetingConnections.connectionStatus,
): SQL {
  return eq(column, "live");
}

// ─── participants ────────────────────────────────────────────────────────────

/**
 * One person in a meeting: a signed-in user across every admission and device
 * they joined with, or a guest's admission (the only identity a guest has).
 * Counts and name lists shown to people are per participant, never per
 * admission or connection, or one person rejoining is shown twice.
 */
export function connectionParticipantKeySql(): SQL {
  return sql`coalesce(${meetingConnections.userId}, ${meetingConnections.admissionId})`;
}

export function admissionParticipantKeySql(): SQL {
  return sql`coalesce(${meetingAdmissions.subjectUserId}, ${meetingAdmissions.id})`;
}

// ─── projection ──────────────────────────────────────────────────────────────

/**
 * The status an attempt projects as: issued (`pending`), reported in the room
 * (`live`), or over (`ended`). The coordinator's projection is the only writer.
 */
export function connectionStatusOf(attempt: {
  joinedAt: number | null;
  endedAt: number | null;
}): MeetingConnectionStatus {
  if (attempt.endedAt !== null) return "ended";
  return attempt.joinedAt !== null ? "live" : "pending";
}

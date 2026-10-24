import type { Database } from "@orbmeet/db";
import type { Meeting } from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { findActiveConnectionByUserId } from "../room/connection-queries";
import { assertSpaceCapability, getSpaceAccess } from "@/modules/spaces/server/helpers";

interface AssertMeetingOptions {
  requireActive?: boolean;
}

interface AssertActiveMeetingParticipantOptions {
  requireSpaceMembership?: boolean;
}

export async function assertMeetingExists(
  db: Database,
  meetingId: string,
  { requireActive = true }: AssertMeetingOptions = {},
) {
  const meeting = await db.query.meetings.findFirst({
    where: {
      RAW: (row) => requireActive
        ? and(eq(row.id, meetingId), eq(row.status, "open"))!
        : eq(row.id, meetingId),
    },
  });
  if (!meeting) throw Errors.NOT_FOUND("Meeting");
  return meeting;
}

/**
 * Managing a past meeting is managing its Space. Once a meeting ends there is
 * no host: its Space's admins (a user-paid Space's owner among them, and a
 * personal Space's owner) manage what it left. While a meeting is open, only
 * its room decides (`authorizeInMeeting`).
 */
export async function canManagePastMeeting(
  db: Database,
  meeting: { spaceId: string },
  userId: string,
): Promise<boolean> {
  const access = await getSpaceAccess(db, meeting.spaceId, userId);
  return access?.capabilities.canManage ?? false;
}

export async function assertPastMeetingManager(db: Database, meetingId: string, userId: string) {
  const meeting = await assertMeetingExists(db, meetingId, { requireActive: false });
  if (!(await canManagePastMeeting(db, meeting, userId))) throw Errors.FORBIDDEN();
  return meeting;
}

// Space access is owned by the spaces domain, including organization-derived access.
export async function assertSpaceMembership(
  db: Database,
  spaceId: string,
  userId: string,
) {
  return assertSpaceCapability(db, spaceId, userId, "canView");
}

/**
 * Membership is the entry boundary for shared-space meetings only. Personal
 * meetings admit non-members through their link's policy.
 */
export async function assertSharedSpaceMembership(
  db: Database,
  meeting: { spaceId: string; spaceKind: "personal" | "shared" },
  userId: string,
) {
  if (meeting.spaceKind !== "shared") return null;
  return assertSpaceMembership(db, meeting.spaceId, userId);
}

async function assertActiveMeetingParticipant(
  db: Database,
  meetingId: string,
  userId: string,
) {
  const connection = await findActiveConnectionByUserId(db, meetingId, userId);
  if (!connection) throw Errors.FORBIDDEN();

  return {
    id: connection.admissionId,
    meetingId: meetingId,
    userId: connection.userId,
    role: connection.role,
    meetingModerator: connection.meetingModerator,
    livekitIdentity: connection.livekitIdentity,
  };
}

export async function assertActiveMeetingParticipantWithSpaceAccess(
  db: Database,
  meetingId: string,
  userId: string,
  { requireSpaceMembership = true, meeting: knownMeeting }: AssertActiveMeetingParticipantOptions & { meeting?: Meeting } = {},
) {
  // Meeting must be fetched first since participant and space checks depend on
  // it — unless the caller already loaded it (every whiteboard server fn does),
  // in which case re-reading it would burn a D1 round trip per call.
  // Provenance contract: pass only a row returned by
  // `assertMeetingExists(..., { requireActive: true })` — this option skips the
  // active-status re-check that row would have performed.
  const meeting = knownMeeting ?? await assertMeetingExists(db, meetingId, { requireActive: true });

  // Participant check and space membership check are independent — run in parallel.
  const [participant] = await Promise.all([
    assertActiveMeetingParticipant(db, meeting.id, userId),
    requireSpaceMembership
      ? assertSharedSpaceMembership(db, meeting, userId)
      : null,
  ]);

  return { meeting, participant };
}

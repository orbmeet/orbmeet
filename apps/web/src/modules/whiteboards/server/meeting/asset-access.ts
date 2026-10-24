import type { Database } from "@orbmeet/db";
import {
  meetingAdmissions,
  meetingConnections,
  meetings,
} from "@orbmeet/db/schema";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { getSpaceAccess } from "@/modules/spaces/server/helpers";
import { connectionIsUnfinished } from "@/modules/meetings/server/connection/state";

/** Minimal current-access projection for immutable whiteboard asset reads. */
export async function canActiveParticipantReadWhiteboardAsset(
  db: Database,
  input: {
    meetingId: string;
    connectionId: string;
    participantIdentity: string;
  },
): Promise<boolean> {
  const [participant] = await db
    .select({
      userId: meetingConnections.userId,
      spaceId: meetings.spaceId,
      spaceKind: meetings.spaceKind,
      subjectType: meetingAdmissions.subjectType,
    })
    .from(meetingConnections)
    .innerJoin(
      meetings,
      and(
        eq(meetings.id, meetingConnections.meetingId),
        eq(meetings.status, "open"),
      ),
    )
    .innerJoin(
      meetingAdmissions,
      and(
        eq(meetingAdmissions.id, meetingConnections.admissionId),
        eq(meetingAdmissions.meetingId, meetings.id),
        eq(meetingAdmissions.admissionStatus, "approved"),
      ),
    )
    .where(
      and(
        eq(meetingConnections.id, input.connectionId),
        eq(meetingConnections.meetingId, input.meetingId),
        eq(meetingConnections.livekitIdentity, input.participantIdentity),
        connectionIsUnfinished(),
      ),
    )
    .limit(1);

  if (!participant) return false;
  // `meetings.space_id` is NOT NULL, so this is unreachable — but it is the
  // branch that decides access when the join above stops guaranteeing a space,
  // and a missing space is the absence of the thing being authorized against,
  // never a reason to allow.
  if (!participant.spaceId) return false;

  // An approved admission plus a live or pending connection is the
  // meeting-scoped authority, and it is the same authority for a guest and for
  // a signed-in attendee. Subject type used to decide this, which made a
  // personal meeting's own invited attendees fail while its guests passed: a
  // personal Space has exactly one member, its owner, so `canView` there means
  // "is the owner" and can never describe an admitted attendee.
  if (participant.spaceKind === "personal") return true;
  if (participant.subjectType === "guest") return true;
  if (!participant.userId) return false;

  // A shared Space adds revocation on top of the admission: removing a member
  // mid-meeting has to take their asset reads with it.
  const spaceAccess = await getSpaceAccess(db, participant.spaceId, participant.userId);
  return spaceAccess?.capabilities.canView === true;
}

export async function canRecorderReadWhiteboardAsset(
  db: Database,
  meetingId: string,
): Promise<boolean> {
  const meeting = await db.query.meetings.findFirst({
    where: {
      RAW: (row) =>
        and(
          eq(row.id, meetingId),
          eq(row.status, "open"),
          or(isNotNull(row.activeEgressId), isNotNull(row.activeStreamEgressId)),
        )!,
    },
    columns: { id: true },
  });
  return Boolean(meeting);
}

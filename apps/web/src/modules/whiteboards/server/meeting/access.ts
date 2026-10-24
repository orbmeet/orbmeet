import type { Database } from "@orbmeet/db";
import {
  whiteboards,
  meetingAdmissions,
  meetingWhiteboards,
  meetingConnections,
  meetings,
  spaceMembers,
  spaces,
} from "@orbmeet/db/schema";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { boundedStatements } from "@/platform/database/db-batching";
import { alias } from "drizzle-orm/sqlite-core";
import { assertSharedSpaceMembership } from "@/modules/meetings/server/access/access-assertions";
import {
  findWhiteboardEligibleConnectionById,
  type ActiveConnectionRecord,
} from "@/modules/meetings/server/room/connection-queries";
import { findWhiteboardIdForSyncRoom } from "@/modules/whiteboards/server/documents";
import type { WhiteboardRole } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import {
  whiteboardCapabilitiesForMeetingRole,
  whiteboardRoleForMeetingConnection,
} from "@/modules/whiteboards/server/meeting/role";
import type { WhiteboardCapabilities } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import type { WhiteboardGrantPrincipal } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import {
  resolveWhiteboardCapabilities,
  whiteboardGrantPrincipalForConnection,
} from "@/modules/whiteboards/server/meeting/grants";
import { isUnfinishedConnection } from "@/modules/meetings/server/connection/state";

export interface ActiveWhiteboardParticipantAccess {
  meetingId: string;
  billingPrincipalType: "user" | "organization";
  billingPrincipalId: string;
  connectionId: string;
  admissionId: string | null;
  participantIdentity: string;
  userId: string | null;
  role: WhiteboardRole;
  capabilities: WhiteboardCapabilities;
  grantPrincipal: WhiteboardGrantPrincipal;
  whiteboardEditGranted: boolean;
  canEditWhiteboard: boolean;
}

/**
 * Socket capabilities must exactly match current meeting authority. A role
 * change therefore closes the stale socket and the client reconnects with a
 * freshly signed token, even if the best-effort realtime refresh nudge failed.
 * This is the whiteboard half of the revocation model; the meeting half is
 * the LiveKit metadata projection.
 */
export function areWhiteboardCapabilitiesStillAllowed(
  claimed: WhiteboardCapabilities,
  current: WhiteboardCapabilities,
): boolean {
  return (
    claimed.canEditWhiteboard === current.canEditWhiteboard &&
    claimed.canControlSurface === current.canControlSurface &&
    claimed.canManageWhiteboard === current.canManageWhiteboard
  );
}

/**
 * Everything in this module is a query, never an assertion: each "not
 * currently active" condition — an ended or deleted meeting included — must
 * resolve to null so `/api/whiteboard/access` answers `{ active: false }`.
 * A throw here surfaces as a 5xx, which the sync server deliberately reads as
 * "validation infrastructure is down" and answers with a bounded stale-allow
 * instead of revoking sockets — the wrong outcome when the Worker is healthy
 * and the meeting is simply over.
 */
async function findOpenMeetingForWhiteboard(db: Database, meetingId: string) {
  const meeting = await db.query.meetings.findFirst({
    where: { RAW: (row) => and(eq(row.id, meetingId), eq(row.status, "open"))! },
    columns: {
      id: true,
      startedByUserId: true,
      spaceId: true,
      spaceKind: true,
      billingPrincipalType: true,
      billingPrincipalId: true,
    },
  });
  return meeting ?? null;
}

async function resolveParticipantAccess(
  db: Database,
  meeting: {
    id: string;
    startedByUserId: string | null;
    spaceId: string;
    spaceKind: "personal" | "shared";
    billingPrincipalType: "user" | "organization";
    billingPrincipalId: string;
  },
  participant: ActiveConnectionRecord,
): Promise<ActiveWhiteboardParticipantAccess | null> {
  if (participant.userId) {
    try {
      await assertSharedSpaceMembership(db, meeting, participant.userId);
    } catch {
      return null;
    }
  }

  const role: WhiteboardRole = whiteboardRoleForMeetingConnection(participant);
  // The role the meeting's room decided and projected onto the connection.
  const baseCapabilities = whiteboardCapabilitiesForMeetingRole(participant.role);
  const grantPrincipal = whiteboardGrantPrincipalForConnection(participant);
  if (!grantPrincipal) return null;
  const { capabilities, whiteboardEditGranted } = await resolveWhiteboardCapabilities(db, {
    meetingId: meeting.id,
    principal: grantPrincipal,
    base: baseCapabilities,
  });

  return {
    meetingId: meeting.id,
    billingPrincipalType: meeting.billingPrincipalType,
    billingPrincipalId: meeting.billingPrincipalId,
    connectionId: participant.connectionId,
    admissionId: participant.admissionId,
    participantIdentity: participant.livekitIdentity,
    userId: participant.userId,
    role,
    capabilities,
    grantPrincipal,
    whiteboardEditGranted,
    canEditWhiteboard: capabilities.canEditWhiteboard,
  };
}

/**
 * Why resolving whiteboard authority for one connection lease failed.
 *
 * `retired` is the only recoverable outcome, and keeping it separate is the
 * whole reason this type exists. A connection id is a per-join lease: a LiveKit
 * reconnect ends the old one and issues a new one while the participant never
 * leaves the Meeting. Socket revalidation answers that with "re-mint your
 * token", whereas `unauthorized` closes the socket terminally.
 */
export type WhiteboardParticipantAccessLookup =
  | { status: "seated"; access: ActiveWhiteboardParticipantAccess }
  | { status: "retired" }
  | { status: "unauthorized" };

/** Complete current-state answer used by the sync server's socket revalidator. */
export type WhiteboardSocketAccessLookup =
  | {
      status: "seated";
      access: ActiveWhiteboardParticipantAccess;
      documentChanged: boolean;
    }
  | { status: "retired" }
  | { status: "unauthorized" };

/**
 * Validate one participant socket with one D1 statement.
 *
 * Generic meeting actions compose the domain queries below because they need
 * their intermediate values. The high-frequency revalidator needs only one
 * immutable answer, so it projects connection, admission, Meeting, current
 * document, Space authority, and edit grant together. The token document is
 * still joined separately: it proves this Meeting actually presented the room
 * named by the credential.
 */
export async function lookupWhiteboardSocketAccess(
  db: Database,
  syncRoomId: string,
  connectionId: string,
  documentId?: string,
): Promise<WhiteboardSocketAccessLookup> {
  const [lookup] = await lookupWhiteboardSocketAccesses(db, syncRoomId, [{ connectionId, documentId }]);
  return lookup;
}

/**
 * {@link lookupWhiteboardSocketAccess} for many sockets of one room, one
 * statement per chunk of connections rather than one per socket: a large room
 * revalidates hundreds of sockets on every authority sweep. Answers come back
 * in request order.
 */
export async function lookupWhiteboardSocketAccesses(
  db: Database,
  syncRoomId: string,
  requests: readonly { connectionId: string; documentId?: string }[],
): Promise<WhiteboardSocketAccessLookup[]> {
  const connectionIds = [...new Set(requests.map((request) => request.connectionId))];
  const rows = new Map<string, SocketAccessRow>();
  for (const lookup of boundedStatements(connectionIds, (chunk) => selectSocketAccessRows(db, syncRoomId, chunk))) {
    // Ordered so each connection's first row is its most recently focused
    // use of this room, the one a single lookup would take.
    for (const row of await lookup) {
      if (!rows.has(row.connectionId)) rows.set(row.connectionId, row);
    }
  }
  return requests.map(({ connectionId, documentId }) =>
    socketAccessFromRow(rows.get(connectionId), syncRoomId, documentId),
  );
}

type SocketAccessRow = Awaited<ReturnType<typeof selectSocketAccessRows>>[number];

function selectSocketAccessRows(db: Database, syncRoomId: string, connectionIds: string[]) {
  // Build aliases on call: this module backs browser-imported server functions,
  // whose client transform stubs schema exports during module evaluation.
  const currentMeetingWhiteboard = alias(meetingWhiteboards, "current_meeting_whiteboard");
  const currentWhiteboard = alias(whiteboards, "current_whiteboard");
  const tokenMeetingWhiteboard = alias(meetingWhiteboards, "token_meeting_whiteboard");
  const tokenWhiteboard = alias(whiteboards, "token_whiteboard");
  const currentMeetingWhiteboardId = sql<string>`(
    select focused_usage.id
    from meeting_whiteboards as focused_usage
    where focused_usage.meeting_id = ${meetings.id}
    order by
      focused_usage.focused_at desc,
      focused_usage.last_presented_at desc,
      focused_usage.attached_at desc
    limit 1
  )`;

  return db
    .select({
      meetingId: meetings.id,
      billingPrincipalType: meetings.billingPrincipalType,
      billingPrincipalId: meetings.billingPrincipalId,
      spaceKind: meetings.spaceKind,
      connectionId: meetingConnections.id,
      admissionId: meetingAdmissions.id,
      admissionStatus: meetingAdmissions.admissionStatus,
      participantIdentity: meetingConnections.livekitIdentity,
      userId: meetingConnections.userId,
      connectionRole: meetingConnections.role,
      connectionStatus: meetingConnections.connectionStatus,
      membershipRole: spaceMembers.role,
      currentSyncRoomId: currentWhiteboard.syncRoomId,
      tokenWhiteboardId: tokenWhiteboard.id,
      // Edit approval is on the admission, so it covers every board the
      // Meeting presents, including boards presented after the approval.
      whiteboardEditGranted: meetingAdmissions.whiteboardEditGranted,
    })
    .from(meetingConnections)
    .innerJoin(meetings, and(
      eq(meetings.id, meetingConnections.meetingId),
      eq(meetings.status, "open"),
    ))
    .innerJoin(meetingAdmissions, and(
      eq(meetingAdmissions.id, meetingConnections.admissionId),
      eq(meetingAdmissions.meetingId, meetings.id),
    ))
    .innerJoin(tokenMeetingWhiteboard, eq(tokenMeetingWhiteboard.meetingId, meetings.id))
    .innerJoin(tokenWhiteboard, and(
      eq(tokenWhiteboard.id, tokenMeetingWhiteboard.whiteboardId),
      eq(tokenWhiteboard.syncRoomId, syncRoomId),
      eq(tokenWhiteboard.status, "active"),
    ))
    .innerJoin(currentMeetingWhiteboard, eq(currentMeetingWhiteboard.id, currentMeetingWhiteboardId))
    .innerJoin(currentWhiteboard, and(
      eq(currentWhiteboard.id, currentMeetingWhiteboard.whiteboardId),
      eq(currentWhiteboard.status, "active"),
    ))
    .innerJoin(spaces, and(
      eq(spaces.id, meetings.spaceId),
      isNull(spaces.archivedAt),
    ))
    .leftJoin(spaceMembers, and(
      eq(spaceMembers.spaceId, meetings.spaceId),
      eq(spaceMembers.userId, meetingConnections.userId),
    ))
    .where(inArray(meetingConnections.id, connectionIds))
    .orderBy(desc(tokenMeetingWhiteboard.focusedAt), desc(tokenMeetingWhiteboard.lastPresentedAt));
}

function socketAccessFromRow(
  row: SocketAccessRow | undefined,
  syncRoomId: string,
  documentId: string | undefined,
): WhiteboardSocketAccessLookup {
  if (!row || row.admissionStatus !== "approved") {
    return { status: "unauthorized" };
  }
  if (row.userId && row.spaceKind === "shared" && row.membershipRole === null) {
    return { status: "unauthorized" };
  }
  if (!isUnfinishedConnection(row.connectionStatus)) return { status: "retired" };

  // The role the meeting's room decided and projected onto the connection.
  // It follows a Space change as soon as the room applies it, exactly as the
  // meeting's own media grants do; this check never re-derives it.
  const baseCapabilities = whiteboardCapabilitiesForMeetingRole(row.connectionRole);
  const whiteboardEditGranted = row.whiteboardEditGranted;
  const capabilities: WhiteboardCapabilities = {
    ...baseCapabilities,
    canEditWhiteboard: baseCapabilities.canEditWhiteboard || whiteboardEditGranted,
  };
  const grantPrincipal: WhiteboardGrantPrincipal = row.userId
    ? { type: "user", id: row.userId }
    : { type: "guest_admission", id: row.admissionId };

  return {
    status: "seated",
    documentChanged:
      row.currentSyncRoomId !== syncRoomId ||
      (documentId !== undefined && row.tokenWhiteboardId !== documentId),
    access: {
      meetingId: row.meetingId,
      billingPrincipalType: row.billingPrincipalType,
      billingPrincipalId: row.billingPrincipalId,
      connectionId: row.connectionId,
      admissionId: row.admissionId,
      participantIdentity: row.participantIdentity,
      userId: row.userId,
      role: whiteboardRoleForMeetingConnection({
        role: row.connectionRole,
        userId: row.userId,
      }),
      capabilities,
      grantPrincipal,
      whiteboardEditGranted,
      canEditWhiteboard: capabilities.canEditWhiteboard,
    },
  };
}

/** One-query resolution for a durable Space editing socket. */
export async function resolveSoloWhiteboardEditor(
  db: Database,
  syncRoomId: string,
  userId: string,
): Promise<{ whiteboardId: string; spaceId: string } | null> {
  const [row] = await db
    .select({ whiteboardId: whiteboards.id, spaceId: whiteboards.spaceId })
    .from(whiteboards)
    .innerJoin(spaceMembers, and(
      eq(spaceMembers.spaceId, whiteboards.spaceId),
      eq(spaceMembers.userId, userId),
    ))
    .innerJoin(spaces, and(
      eq(spaces.id, whiteboards.spaceId),
      isNull(spaces.archivedAt),
    ))
    .where(and(
      eq(whiteboards.syncRoomId, syncRoomId),
      eq(whiteboards.status, "active"),
    ))
    .limit(1);
  return row ?? null;
}

/** One-query validation for the recorder service's presented room. */
export async function canAccessWhiteboardRoomAsRecorder(
  db: Database,
  syncRoomId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: meetings.id })
    .from(meetingWhiteboards)
    .innerJoin(whiteboards, and(
      eq(whiteboards.id, meetingWhiteboards.whiteboardId),
      eq(whiteboards.syncRoomId, syncRoomId),
      eq(whiteboards.status, "active"),
    ))
    .innerJoin(meetings, and(
      eq(meetings.id, meetingWhiteboards.meetingId),
      eq(meetings.status, "open"),
      or(isNotNull(meetings.activeEgressId), isNotNull(meetings.activeStreamEgressId)),
    ))
    .orderBy(desc(meetingWhiteboards.focusedAt), desc(meetingWhiteboards.lastPresentedAt))
    .limit(1);
  return Boolean(row);
}

/**
 * `syncRoomId` names the specific room being validated; a room that resolves
 * to no document is refused. Edit approval is for the Meeting, so it applies
 * to whichever of its boards the room is.
 */
export async function lookupWhiteboardParticipantAccess(
  db: Database,
  meetingId: string,
  connectionId: string,
  syncRoomId?: string,
): Promise<WhiteboardParticipantAccessLookup> {
  const meeting = await findOpenMeetingForWhiteboard(db, meetingId);
  if (!meeting) return { status: "unauthorized" };

  const normalizedConnectionId = connectionId.trim();
  if (!normalizedConnectionId) return { status: "unauthorized" };

  // A named room that resolves to no document denies rather than falling
  // back to the surfaced document.
  if (syncRoomId && !(await findWhiteboardIdForSyncRoom(db, syncRoomId))) {
    return { status: "unauthorized" };
  }

  const participant = await findWhiteboardEligibleConnectionById(db, meetingId, normalizedConnectionId);
  // The Meeting is open but this lease is not the current one, so the caller
  // holds credentials for a join that has already been superseded.
  if (!participant) return { status: "retired" };

  const access = await resolveParticipantAccess(db, meeting, participant);
  return access ? { status: "seated", access } : { status: "unauthorized" };
}

/**
 * Whiteboard authority for one connection lease, or null when the caller is not
 * authorized. Request handlers want exactly this: they either serve the request
 * or refuse it, and a retired lease is just another refusal.
 */
export async function getActiveWhiteboardParticipantAccess(
  db: Database,
  meetingId: string,
  connectionId: string,
  syncRoomId?: string,
): Promise<ActiveWhiteboardParticipantAccess | null> {
  const lookup = await lookupWhiteboardParticipantAccess(
    db,
    meetingId,
    connectionId,
    syncRoomId,
  );
  return lookup.status === "seated" ? lookup.access : null;
}

export async function canAccessWhiteboardAsRecorder(
  db: Database,
  meetingId: string,
): Promise<boolean> {
  const meeting = await db.query.meetings.findFirst({
    where: { RAW: (row) => and(
      eq(row.id, meetingId),
      eq(row.status, "open"),
      or(
        isNotNull(row.activeEgressId),
        isNotNull(row.activeStreamEgressId),
      ),
    )! },
    columns: { id: true },
  });

  return Boolean(meeting);
}

import type { MeetingConnectionStatus } from "@/modules/meetings/contract/constants";
import type { Database } from "@orbmeet/db";
import type { MeetingRole } from "@/modules/meetings/contract/constants";
import { meetingAdmissions, meetingConnections } from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import { connectionIsUnfinished, isEndedConnection } from "../connection/state";

type ConnectionRow = {
  id: string;
  admissionId: string;
  livekitIdentity: string;
  userId: string | null;
  role: MeetingRole;
  meetingModerator: boolean;
  displayName: string;
  connectionStatus: MeetingConnectionStatus;
  tokenIssuedAt: Date;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
};

export interface ActiveConnectionRecord {
  connectionId: string;
  admissionId: string;
  livekitIdentity: string;
  userId: string | null;
  role: MeetingRole;
  meetingModerator: boolean;
  /**
   * The name this person joined under, from their admission — the same string
   * the room shows on their tile. Guests type it at the door and it is
   * `notNull`, so nothing downstream needs to invent a name for them; a
   * request that says "Guest" is a request the host cannot act on.
   */
  displayName: string;
}

// `role` is the meeting room's decision for this connection, projected by the
// room whenever it changes; work outside the room reads it rather than deciding
// again. The moderator grant behind it is on the admission.
//
// Built on call rather than at module scope: this module is client-reachable (it
// backs server functions the browser imports), and reading schema columns while
// the module evaluates would run against the client's server-module stub.
function connectionRecordProjection() {
  return {
    id: meetingConnections.id,
    admissionId: meetingConnections.admissionId,
    livekitIdentity: meetingConnections.livekitIdentity,
    userId: meetingConnections.userId,
    role: meetingConnections.role,
    meetingModerator: meetingAdmissions.meetingModerator,
    displayName: meetingAdmissions.displayName,
    connectionStatus: meetingConnections.connectionStatus,
    tokenIssuedAt: meetingConnections.tokenIssuedAt,
    connectedAt: meetingConnections.connectedAt,
    disconnectedAt: meetingConnections.disconnectedAt,
  } as const;
}

function admissionJoinCondition() {
  return and(
    eq(meetingAdmissions.id, meetingConnections.admissionId),
    eq(meetingAdmissions.meetingId, meetingConnections.meetingId),
    // Every "active participant" lookup implies a currently-approved admission.
    // Today revocation always ends the connection in the same transaction, so
    // this is defense in depth — it makes the immediate-revocation model local
    // to the query instead of an emergent property of the revocation writers
    // (the whiteboard socket revalidation path depends on it).
    eq(meetingAdmissions.admissionStatus, "approved"),
  );
}


/*
 * Whiteboard authority uses the same rule as every other "active participant"
 * lookup: an unfinished connection. A joiner holds valid credentials from the
 * moment the join endpoint answers, but the row only turns `live` once the
 * meeting's room learns LiveKit admitted them — from a webhook it may never
 * get, or from its own look at the room. Demanding `live`, or `pending` only
 * for a while, made whiteboard access lose that race: the surface-state read,
 * the token mint, and the sync server's socket admission all denied a
 * participant the rest of the meeting considered present, and a denied socket
 * is terminal. A token never used is ended by the room once it looks.
 */

function compareConnectionRecency(a: ConnectionRow, b: ConnectionRow): number {
  const rank = (row: ConnectionRow) => {
    switch (row.connectionStatus) {
      case "live":
        return 3;
      case "pending":
        return 2;
      case "ended":
        return 1;
    }
  };

  const rankDiff = rank(b) - rank(a);
  if (rankDiff !== 0) return rankDiff;

  const activityA =
    isEndedConnection(a.connectionStatus)
      ? a.disconnectedAt?.getTime() ?? 0
      : a.connectedAt?.getTime() ?? a.tokenIssuedAt.getTime();
  const activityB =
    isEndedConnection(b.connectionStatus)
      ? b.disconnectedAt?.getTime() ?? 0
      : b.connectedAt?.getTime() ?? b.tokenIssuedAt.getTime();

  return activityB - activityA;
}

function toConnectionRecord(row: ConnectionRow): ActiveConnectionRecord {
  return {
    connectionId: row.id,
    admissionId: row.admissionId,
    livekitIdentity: row.livekitIdentity,
    userId: row.userId,
    role: row.role,
    meetingModerator: row.meetingModerator,
    displayName: row.displayName,
  };
}

export async function findWhiteboardEligibleConnectionById(
  db: Database,
  meetingId: string,
  connectionId: string,
): Promise<ActiveConnectionRecord | null> {
  const [projected] = await db
    .select(connectionRecordProjection())
    .from(meetingConnections)
    .innerJoin(meetingAdmissions, admissionJoinCondition())
    .where(
      and(
        eq(meetingConnections.meetingId, meetingId),
        eq(meetingConnections.id, connectionId),
        connectionIsUnfinished(),
      ),
    )
    .limit(1);

  return projected ? toConnectionRecord(projected) : null;
}

export async function findActiveConnectionByUserId(
  db: Database,
  meetingId: string,
  userId: string,
): Promise<ActiveConnectionRecord | null> {
  const projected = await db
    .select(connectionRecordProjection())
    .from(meetingConnections)
    .innerJoin(meetingAdmissions, admissionJoinCondition())
    .where(
      and(
        eq(meetingConnections.meetingId, meetingId),
        eq(meetingConnections.userId, userId),
        connectionIsUnfinished(),
      ),
    );

  const eligible = projected.sort(compareConnectionRecency)[0];

  return eligible ? toConnectionRecord(eligible) : null;
}

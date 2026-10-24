import type { Database } from "@orbmeet/db";
import { Errors } from "@/lib/app-errors";
import { meetingAdmissions, meetingConnections } from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import { verifyGuestAdmissionBySecret } from "../access/guest-admission";
import { connectionIsUnfinished } from "@/modules/meetings/server/connection/state";

/** Resolve an active connection and prove that it belongs to the current user or guest. */
export async function getOwnedActiveMeetingConnection(
  db: Database,
  input: {
    meetingId: string;
    connectionId: string;
    authenticatedUserId: string | null;
    guestCookieSecret?: string | null;
  },
) {
  // Moderator grant comes from the admission (source of truth); the connection
  // carries only the derived role cache.
  const [connection] = await db
    .select({
      id: meetingConnections.id,
      admissionId: meetingConnections.admissionId,
      userId: meetingConnections.userId,
      livekitIdentity: meetingConnections.livekitIdentity,
      role: meetingConnections.role,
      meetingModerator: meetingAdmissions.meetingModerator,
    })
    .from(meetingConnections)
    .innerJoin(
      meetingAdmissions,
      and(
        eq(meetingAdmissions.id, meetingConnections.admissionId),
        eq(meetingAdmissions.meetingId, meetingConnections.meetingId),
        // "Owns an active connection" implies a currently-approved admission,
        // the same rule every other active-participant lookup applies. Today
        // revocation ends the connection in the same transaction, so the status
        // filter below already covers this — stating it here keeps the guarantee
        // local to the query instead of resting on every future revocation
        // writer remembering to tombstone connections too.
        eq(meetingAdmissions.admissionStatus, "approved"),
      ),
    )
    .where(
      and(
        eq(meetingConnections.id, input.connectionId),
        eq(meetingConnections.meetingId, input.meetingId),
        connectionIsUnfinished(),
      ),
    )
    .limit(1);

  if (!connection) throw Errors.NOT_FOUND("Participant");

  if (input.authenticatedUserId) {
    if (connection.userId !== input.authenticatedUserId) throw Errors.FORBIDDEN();
  } else {
    if (connection.userId !== null) throw Errors.FORBIDDEN();
    await verifyGuestAdmissionBySecret(
      db,
      input.meetingId,
      connection.admissionId,
      input.guestCookieSecret ?? null,
    );
  }

  return connection;
}

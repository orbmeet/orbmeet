import type { Database } from "@orbmeet/db";
import { meetingAdmissions } from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import type { WhiteboardGrantPrincipal } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import type { ActiveConnectionRecord } from "@/modules/meetings/server/room/connection-queries";
import type { WhiteboardCapabilities } from "@orbmeet/whiteboard-core/whiteboard-jwt";

// Edit approval is a grant on the participant's admission, decided by the
// Meeting's coordinator (`grantBoardEdit`) like moderator and screen-share
// grants. It covers every board the Meeting presents, survives a reconnect, and
// ends when the admission does.
//
// The board server names people as `{ type: "user" | "guest_admission", id }`.

export function whiteboardGrantPrincipalForConnection(
  connection: Pick<ActiveConnectionRecord, "userId" | "admissionId">,
): WhiteboardGrantPrincipal | null {
  if (connection.userId) {
    return { type: "user", id: connection.userId };
  }
  if (connection.admissionId) {
    return { type: "guest_admission", id: connection.admissionId };
  }
  return null;
}

/** Add the participant's edit grant, if the coordinator gave one, to role-derived capabilities. */
export async function resolveWhiteboardCapabilities(
  db: Database,
  input: {
    meetingId: string;
    principal: WhiteboardGrantPrincipal;
    base: WhiteboardCapabilities;
  },
): Promise<{ capabilities: WhiteboardCapabilities; whiteboardEditGranted: boolean }> {
  const [granted] = await db
    .select({ id: meetingAdmissions.id })
    .from(meetingAdmissions)
    .where(and(
      eq(meetingAdmissions.meetingId, input.meetingId),
      eq(meetingAdmissions.admissionStatus, "approved"),
      eq(meetingAdmissions.whiteboardEditGranted, true),
      input.principal.type === "user"
        ? eq(meetingAdmissions.subjectUserId, input.principal.id)
        : and(eq(meetingAdmissions.subjectType, "guest"), eq(meetingAdmissions.id, input.principal.id)),
    ))
    .limit(1);
  const whiteboardEditGranted = Boolean(granted);
  return {
    capabilities: {
      canEditWhiteboard: input.base.canEditWhiteboard || whiteboardEditGranted,
      canControlSurface: input.base.canControlSurface,
      canManageWhiteboard: input.base.canManageWhiteboard,
    },
    whiteboardEditGranted,
  };
}

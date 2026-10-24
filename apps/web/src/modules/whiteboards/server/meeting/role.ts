import { isGuestIdentity, type MeetingRole } from "@/modules/meetings/contract/constants";
import type { WhiteboardCapabilities, WhiteboardRole } from "@orbmeet/whiteboard-core/whiteboard-jwt";

// Whiteboard roles are identity labels only. Authority comes from capabilities.
function projectWhiteboardRole(isGuest: boolean): WhiteboardRole {
  return isGuest ? "guest" : "participant";
}

// Moderators get every Whiteboard capability even though Meeting lifecycle
// management remains host-only. Anything less created a trap: a moderator could
// open the board for everyone but connect read-only, and in a host-absent Meeting
// nobody present could edit or approve edits — leaving the surface permanently
// frozen. Attendees remain view-only until a manager grants edit access.
export function whiteboardCapabilitiesForMeetingRole(role: MeetingRole): WhiteboardCapabilities {
  const isManager = role === "host" || role === "moderator";
  return {
    canEditWhiteboard: isManager,
    canControlSurface: isManager,
    canManageWhiteboard: isManager,
  };
}

export function whiteboardRoleForMeetingConnection(connection: {
  role: MeetingRole;
  userId: string | null;
}): WhiteboardRole {
  return projectWhiteboardRole(connection.userId === null);
}

export function whiteboardRoleForMeetingIdentity(
  role: MeetingRole,
  participantIdentity: string,
): WhiteboardRole {
  void role;
  return projectWhiteboardRole(isGuestIdentity(participantIdentity));
}

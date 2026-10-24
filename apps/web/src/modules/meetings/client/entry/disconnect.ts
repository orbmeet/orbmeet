import { DisconnectReason } from "livekit-client";

export type MeetingDisconnectDisposition =
  | { kind: "ignore" }
  | { kind: "ended" }
  | { kind: "terminal"; message: string }
  // Forcibly removed by the SFU. The cause (capacity overflow vs. revoked
  // access vs. moderator removal vs. a media-node move) isn't carried on the
  // disconnect, so the client re-asks the join endpoint to surface it.
  | { kind: "removed" }
  | { kind: "rejoin" };

/**
 * What an unrequested disconnect of an established connection means. A
 * connection that never reached `connected` fails through its connect error
 * instead, so its disconnect is ignored here.
 */
export function getMeetingDisconnectDisposition(
  reason: DisconnectReason | undefined,
  everConnected: boolean,
): MeetingDisconnectDisposition {
  if (!everConnected) return { kind: "ignore" };
  switch (reason) {
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return { kind: "ended" };
    case DisconnectReason.DUPLICATE_IDENTITY:
      return { kind: "terminal", message: "This meeting is open in another tab or device." };
    case DisconnectReason.PARTICIPANT_REMOVED:
      return { kind: "removed" };
    case DisconnectReason.CLIENT_INITIATED:
      return { kind: "ignore" };
    default:
      return { kind: "rejoin" };
  }
}

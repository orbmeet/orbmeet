import { DisconnectReason } from "livekit-client";

export type MeetingDisconnectDisposition =
  | { kind: "ignore" }
  | { kind: "ended" }
  | { kind: "terminal"; message: string }
  // Forcibly removed by the SFU. The cause (capacity overflow vs. revoked
  // access vs. moderator removal vs. a media-node move) isn't carried on the
  // disconnect, so the client re-asks the join endpoint to surface it.
  | { kind: "removed" }
  // `nodeLost`: the link to the media node failed, so the rejoin names that
  // node and the Worker checks it. A page-lifecycle disconnect says nothing
  // about the node.
  | { kind: "rejoin"; nodeLost: boolean };

/**
 * What an unrequested disconnect of an established connection means. A
 * connection that never reached `connected` fails through its connect error
 * instead, so its disconnect is ignored here.
 *
 * The session never asks this about its own disconnects: leaving moves it out
 * of the connected phase, and a replaced link no longer matches. A page that
 * is really going away leaves the same way (`MeetingConnection` begins the
 * leave on a final `pagehide`). So a `CLIENT_INITIATED` that arrives here is
 * from a page put into the back/forward cache, which `MeetingConnection`
 * disconnects; the page that comes back needs a connection again. (LiveKit
 * also listens for `freeze`, but on `window`, which that event never reaches:
 * it is fired at the document and does not bubble. A frozen page instead
 * loses its connection to timeouts and finds out when it resumes.)
 * Recovery runs on timers, which a hidden or frozen page may not run, so it
 * also starts when the page shows again.
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
      return { kind: "rejoin", nodeLost: false };
    default:
      return { kind: "rejoin", nodeLost: true };
  }
}

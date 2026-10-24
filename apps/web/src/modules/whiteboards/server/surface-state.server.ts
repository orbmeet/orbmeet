import "@tanstack/react-start/server-only";
import type { MeetingSurfaceState, SurfaceFocus } from "@/modules/meetings/contract/live-state";
import type { SubjectInput } from "@/modules/meetings/server/runtime/api";
import { callCoordinator } from "@/modules/meetings/server/runtime/client.server";
import { Errors } from "@/lib/app-errors";
import type { MeetingWhiteboardDocument } from "./documents";

// The shared surface belongs to the Meeting's room, like everything else live
// about the Meeting: these only prepare a Whiteboard in D1 and hand the room
// the command. The room orders every open, close and switch, pins what each
// boundary shared, and tells every participant through room metadata.

function surfaceFocusOf(document: MeetingWhiteboardDocument): SurfaceFocus {
  return {
    usageId: document.meetingWhiteboardId,
    whiteboardId: document.whiteboardId,
    syncRoomId: document.syncRoomId,
  };
}

/**
 * Open the surface for everyone (showing the presented board, or `fallback`
 * when the Meeting presents none yet), or close it.
 */
export async function setMeetingSurface(
  env: Env,
  meetingId: string,
  subject: SubjectInput,
  open: boolean,
  fallback: MeetingWhiteboardDocument | null,
): Promise<MeetingSurfaceState> {
  const reply = await callCoordinator(env, {
    kind: "command",
    meetingId,
    command: { kind: "setSurface", subject, open, fallback: fallback && surfaceFocusOf(fallback) },
  });
  if (reply.kind !== "surface") throw Errors.INTERNAL();
  return reply.surface;
}

/** Present an attached Whiteboard, opening the surface on it. */
export async function presentOnMeetingSurface(
  env: Env,
  meetingId: string,
  subject: SubjectInput,
  document: MeetingWhiteboardDocument,
): Promise<MeetingSurfaceState> {
  const reply = await callCoordinator(env, {
    kind: "command",
    meetingId,
    command: { kind: "present", subject, focus: surfaceFocusOf(document) },
  });
  if (reply.kind !== "surface") throw Errors.INTERNAL();
  return reply.surface;
}

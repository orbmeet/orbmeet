import type { MeetingSurfaceState } from "@/modules/meetings/contract/live-state";

export type RecorderStage = "whiteboard" | "screen_share" | "video";

/**
 * What a recording shows, from what the meeting shows everyone: a shared
 * screen first, then the shared whiteboard, else the participants. Derived
 * from the room's own state, never from what one participant is looking at.
 */
export function selectRecorderStage(input: {
  hasScreenShare: boolean;
  surface: MeetingSurfaceState | null | undefined;
}): RecorderStage {
  if (input.hasScreenShare) return "screen_share";
  if (input.surface?.open && input.surface.whiteboardId) return "whiteboard";
  return "video";
}

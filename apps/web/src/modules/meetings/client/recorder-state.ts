import type { MeetingSurfaceState } from "@/modules/meetings/contract/live-state";

export type RecorderWhiteboardStatus = "loading" | "ready" | "error";
export type RecorderStage = "whiteboard" | "screen_share" | "video";
export type RecorderEgressMode = "recording" | "streaming" | null;

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

export function parseRecorderHashParams(
  hashValue: string,
  searchValue = "",
): URLSearchParams {
  const params = new URLSearchParams(
    searchValue.startsWith("?") ? searchValue.slice(1) : searchValue,
  );
  const hash = hashValue.startsWith("#") ? hashValue.slice(1) : hashValue;
  const questionIndex = hash.indexOf("?");
  const normalized =
    questionIndex === -1
      ? hash
      : `${hash.slice(0, questionIndex)}&${hash.slice(questionIndex + 1)}`;
  const hashParams = new URLSearchParams(normalized);
  hashParams.forEach((value, key) => params.set(key, value));
  return params;
}

export function shouldMountRecorderWhiteboard({
  hasWhiteboard,
  stage,
  wbStatus,
}: {
  hasWhiteboard: boolean;
  stage: RecorderStage;
  wbStatus: RecorderWhiteboardStatus;
}): boolean {
  return hasWhiteboard && stage === "whiteboard" && wbStatus !== "error";
}

export function shouldWaitForRecorderWhiteboard({
  hasWhiteboard,
  stage,
}: {
  egressMode?: RecorderEgressMode;
  hasWhiteboard: boolean;
  stage: RecorderStage;
}): boolean {
  return hasWhiteboard && stage === "whiteboard";
}

export function isRecorderStartupBlockedByWhiteboard({
  egressMode,
  hasWhiteboard,
  stage,
  wbStatus,
  wbTimedOut,
}: {
  egressMode?: RecorderEgressMode;
  hasWhiteboard: boolean;
  stage: RecorderStage;
  wbStatus: RecorderWhiteboardStatus;
  wbTimedOut: boolean;
}): boolean {
  return (
    shouldWaitForRecorderWhiteboard({ egressMode, hasWhiteboard, stage }) &&
    wbStatus === "loading" &&
    !wbTimedOut
  );
}

export function isRecorderStartupBlockedByWhiteboardContent({
  egressMode,
  hasWhiteboard,
  stage,
  wbStatus,
  wbHasContent,
  wbContentTimedOut,
}: {
  egressMode?: RecorderEgressMode;
  hasWhiteboard: boolean;
  stage: RecorderStage;
  wbStatus: RecorderWhiteboardStatus;
  wbHasContent: boolean;
  wbContentTimedOut: boolean;
}): boolean {
  return (
    shouldWaitForRecorderWhiteboard({ egressMode, hasWhiteboard, stage }) &&
    wbStatus === "ready" &&
    !wbHasContent &&
    !wbContentTimedOut
  );
}

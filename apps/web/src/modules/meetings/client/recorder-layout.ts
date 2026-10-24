export type RecorderWhiteboardStatus = "loading" | "ready" | "error";
export type RecorderStage = "whiteboard" | "screen_share" | "video";
export type RecorderEgressMode = "recording" | "streaming" | null;

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

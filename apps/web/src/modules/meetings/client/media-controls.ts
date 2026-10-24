import type { LiveMeetingState } from "./use-live-meeting";

export interface MediaControlsAvailability {
  recordingDisabled: boolean;
  /**
   * Why recording is unavailable, not just that it is. "Recording is
   * unavailable" is a dead end: the four reasons send you to four different
   * places — upgrade a plan, ask the host, wait, or stop the stream.
   */
  recordingDisabledReason: string | null;
  streamingDisabled: boolean;
}

/**
 * Recording and streaming availability, shared by the phone dock and the
 * desktop control bar. Computed inline in both, these expressions had begun to
 * drift; one source keeps the two chrome variants in agreement.
 */
export function mediaControlsAvailability(
  meeting: Pick<LiveMeetingState, "recordingEnabled" | "canManageMeeting" | "recording" | "streaming">,
): MediaControlsAvailability {
  const { recordingEnabled, canManageMeeting, recording, streaming } = meeting;
  return {
    recordingDisabled:
      !recordingEnabled || !canManageMeeting || recording.recordingPending || streaming.isStreaming,
    recordingDisabledReason: !recordingEnabled
      ? "Recording isn't included in this meeting's plan"
      : !canManageMeeting
        ? "Only a Meeting manager can record"
        : streaming.isStreaming
          ? "Stop the live stream first"
          : recording.recordingPending
            ? "Finishing the last request…"
            : null,
    streamingDisabled:
      !canManageMeeting || streaming.streamingPending || (!streaming.isStreaming && recording.isRecording),
  };
}

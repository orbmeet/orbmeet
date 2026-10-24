import { describe, expect, it } from "vitest";
import { mediaControlsAvailability } from "./media-controls";

type Input = Parameters<typeof mediaControlsAvailability>[0];

function meeting(overrides: {
  recordingEnabled?: boolean;
  canManageMeeting?: boolean;
  isRecording?: boolean;
  recordingPending?: boolean;
  isStreaming?: boolean;
  streamingPending?: boolean;
} = {}): Input {
  return {
    recordingEnabled: overrides.recordingEnabled ?? true,
    canManageMeeting: overrides.canManageMeeting ?? true,
    recording: {
      isRecording: overrides.isRecording ?? false,
      recordingPending: overrides.recordingPending ?? false,
    },
    streaming: {
      isStreaming: overrides.isStreaming ?? false,
      streamingPending: overrides.streamingPending ?? false,
    },
  } as unknown as Input;
}

describe("mediaControlsAvailability", () => {
  it("allows a manager on a plan with recording to record and stream", () => {
    expect(mediaControlsAvailability(meeting())).toEqual({
      recordingDisabled: false,
      recordingDisabledReason: null,
      streamingDisabled: false,
    });
  });

  it("names the first thing standing in the way of recording", () => {
    expect(mediaControlsAvailability(meeting({ recordingEnabled: false, canManageMeeting: false })).recordingDisabledReason)
      .toBe("Recording isn't included in this meeting's plan");
    expect(mediaControlsAvailability(meeting({ canManageMeeting: false })).recordingDisabledReason)
      .toBe("Only a Meeting manager can record");
    expect(mediaControlsAvailability(meeting({ isStreaming: true, recordingPending: true })).recordingDisabledReason)
      .toBe("Stop the live stream first");
    expect(mediaControlsAvailability(meeting({ recordingPending: true })).recordingDisabledReason)
      .toBe("Finishing the last request…");
  });

  it("keeps a live stream stoppable while recording, but starts none over a recording", () => {
    expect(mediaControlsAvailability(meeting({ isRecording: true })).streamingDisabled).toBe(true);
    expect(mediaControlsAvailability(meeting({ isRecording: true, isStreaming: true })).streamingDisabled).toBe(false);
    expect(mediaControlsAvailability(meeting({ streamingPending: true })).streamingDisabled).toBe(true);
  });
});

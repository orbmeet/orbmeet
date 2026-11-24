import { describe, expect, it, vi } from "vitest";
import { TwirpError } from "livekit-server-sdk";
import { isLiveKitEgressOverError, isLiveKitMissingError, zeroPermissionsAndRemoveParticipant } from "./livekit-removal";

describe("zeroPermissionsAndRemoveParticipant", () => {
  it("removes the participant but reports a failed permission revocation for retry", async () => {
    const permissionError = new Error("LiveKit temporarily unavailable");
    const roomService = {
      updateParticipant: vi.fn().mockRejectedValue(permissionError),
      removeParticipant: vi.fn().mockResolvedValue(undefined),
    };

    await expect(zeroPermissionsAndRemoveParticipant(
      roomService as never,
      "meet-meeting_1",
      "participant_1",
      "[test]",
    )).rejects.toBe(permissionError);
    expect(roomService.removeParticipant).toHaveBeenCalledOnce();
  });
});

describe("LiveKit stop errors", () => {
  // What LiveKit's StopEgress answers for an egress that completed, failed or
  // was aborted on its own.
  const over = new TwirpError("Precondition Failed", "egress with status EGRESS_COMPLETE cannot be stopped", 412, "failed_precondition");

  it("reads a refusal to stop an egress that already ended as nothing left to stop", () => {
    expect(isLiveKitEgressOverError(over)).toBe(true);
    expect(isLiveKitMissingError(over)).toBe(false);
  });

  it("does not take other failures for it", () => {
    expect(isLiveKitEgressOverError(new TwirpError("Unavailable", "egress not connected", 503, "unavailable"))).toBe(false);
    expect(isLiveKitEgressOverError(new Error("fetch failed"))).toBe(false);
    expect(isLiveKitEgressOverError(null)).toBe(false);
  });
});

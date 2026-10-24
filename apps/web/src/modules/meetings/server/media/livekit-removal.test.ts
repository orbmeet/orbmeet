import { describe, expect, it, vi } from "vitest";
import { zeroPermissionsAndRemoveParticipant } from "./livekit-removal";

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

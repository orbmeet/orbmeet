import { describe, expect, it } from "vitest";
import { isWhiteboardToggleDisabled } from "@/modules/whiteboards/client/meeting/whiteboard-toolbar-state";

describe("isWhiteboardToggleDisabled", () => {
  it("leaves the Board button to everyone: a moderator opens, anyone else asks", () => {
    expect(isWhiteboardToggleDisabled({ canAttemptOpen: true })).toBe(false);
  });

  it("keeps an unavailable surface disabled", () => {
    expect(isWhiteboardToggleDisabled({ canAttemptOpen: false })).toBe(true);
  });
});

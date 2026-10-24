import { describe, expect, it } from "vitest";
import { whiteboardCapabilitiesForMeetingRole } from "@/modules/whiteboards/server/meeting/role";

describe("whiteboardCapabilitiesForMeetingRole", () => {
  it("grants a host every whiteboard capability", () => {
    expect(whiteboardCapabilitiesForMeetingRole("host")).toEqual({
      canEditWhiteboard: true,
      canControlSurface: true,
      canManageWhiteboard: true,
    });
  });

  // Meeting lifecycle management stays host-only. The equal projection here is
  // deliberately scoped to the collaborative Whiteboard surface.
  it("grants a moderator the same Whiteboard capabilities as a host", () => {
    expect(whiteboardCapabilitiesForMeetingRole("moderator")).toEqual(
      whiteboardCapabilitiesForMeetingRole("host"),
    );
  });

  it("keeps a moderator able to edit and manage the Whiteboard", () => {
    const moderator = whiteboardCapabilitiesForMeetingRole("moderator");
    expect(moderator.canEditWhiteboard).toBe(true);
    expect(moderator.canManageWhiteboard).toBe(true);
  });

  it("leaves an attendee view-only until granted access at runtime", () => {
    expect(whiteboardCapabilitiesForMeetingRole("attendee")).toEqual({
      canEditWhiteboard: false,
      canControlSurface: false,
      canManageWhiteboard: false,
    });
  });
});

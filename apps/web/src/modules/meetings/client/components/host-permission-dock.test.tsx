/**
 * The request tray's one job is to say *who* is asking. These tests hold that
 * line: a request always shows the requester's name, and "Guest" is a badge
 * beside the name rather than a stand-in for it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HostPermissionDock } from "./host-permission-dock";
import type { HostPermissionRequest } from "@/modules/meetings/client/types";

const noop = () => {};

function render(requests: HostPermissionRequest[]) {
  return renderToStaticMarkup(
    <HostPermissionDock
      requests={requests}
      onApproveScreenShare={noop}
      onDenyScreenShare={noop}
      onApproveAdmission={noop}
      onDenyAdmission={noop}
      onApproveExtraPermission={noop}
      onDenyExtraPermission={noop}
    />,
  );
}

describe("HostPermissionDock", () => {
  it("names the guest who is asking, and marks them a guest beside the name", () => {
    const markup = render([
      {
        kind: "extension",
        id: "whiteboard-guest_admission:adm_1",
        userId: "guest_admission:adm_1",
        userName: "Rafi Ahmed",
        guest: true,
        actionLabel: "whiteboard access",
        description: "Wants to draw on the whiteboard",
      },
    ]);

    expect(markup).toContain("Rafi Ahmed");
    expect(markup).toContain("Wants to draw on the whiteboard");
    expect(markup).toContain("Guest · already in the meeting");
    expect(markup).toContain('aria-label="Approve whiteboard access for Rafi Ahmed"');
  });

  it("says where an admission request is waiting and what it would join as", () => {
    const markup = render([
      {
        kind: "meeting-admission",
        id: "admission-1",
        admissionId: "adm_2",
        userId: "user_9",
        userName: "Yousuf Karim",
        role: "attendee",
      },
    ]);

    expect(markup).toContain("Yousuf Karim");
    expect(markup).toContain("Waiting to be let in");
    expect(markup).toContain("Signed in · joining as attendee");
  });

  it("counts the queue only when there is more than one request", () => {
    const one = render([
      {
        kind: "screen-share",
        id: "screen-1",
        userId: "user_1",
        userName: "Atiq Rahman",
      },
    ]);
    expect(one).not.toContain("requests");

    const two = render([
      {
        kind: "screen-share",
        id: "screen-1",
        userId: "user_1",
        userName: "Atiq Rahman",
      },
      {
        kind: "screen-share",
        id: "screen-2",
        userId: "user_2",
        userName: "Yousuf Karim",
      },
    ]);
    expect(two).toContain("2 requests");
  });

  it("renders nothing when the queue is empty", () => {
    expect(render([])).toBe("");
  });
});

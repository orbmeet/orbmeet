import { describe, expect, it } from "vitest";
import { type ExistingPersonalMeetingLink } from "@/modules/meetings/server/lifecycle/create.server";
import {existingLinkMatchesRequest} from "@/modules/meetings/server/lifecycle/create.server";

const link: ExistingPersonalMeetingLink = {
  id: "link_1",
  code: "abc-defg-hij",
  title: null,
  allowGuests: true,
  joinPolicy: "open",
};

describe("existingLinkMatchesRequest", () => {
  it("recognizes an exact retry of permanent-link creation", () => {
    expect(existingLinkMatchesRequest(link, {
      customCode: link.code,
      allowGuests: true,
      joinPolicy: "open",
    })).toBe(true);
  });

  it("does not silently accept a request for different link settings", () => {
    expect(existingLinkMatchesRequest(link, {
      customCode: "new-room-now",
      allowGuests: true,
      joinPolicy: "open",
    })).toBe(false);
    expect(existingLinkMatchesRequest(link, {
      customCode: link.code,
      allowGuests: true,
      joinPolicy: "approval_required",
    })).toBe(false);
  });
  // Plans without custom codes never send `customCode`, which is the whole free
  // tier — the branch has to work for them or it works for nobody.
  it("recognizes a retry from a caller who cannot name a code", () => {
    expect(existingLinkMatchesRequest(link, {
      allowGuests: true,
      joinPolicy: "open",
    })).toBe(true);
  });

  it("still refuses different settings when no code was named", () => {
    expect(existingLinkMatchesRequest(link, {
      allowGuests: false,
      joinPolicy: "open",
    })).toBe(false);
    expect(existingLinkMatchesRequest(link, {
      title: "Standup",
      allowGuests: true,
      joinPolicy: "open",
    })).toBe(false);
  });
});

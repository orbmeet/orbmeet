import { describe, expect, it } from "vitest";
import { selectJoinErrorPresentation } from "./join-error-presentation";

describe("selectJoinErrorPresentation", () => {
  it("explains a full meeting instead of only stating it", () => {
    const presentation = selectJoinErrorPresentation("PLAN_LIMIT_REACHED");
    expect(presentation.title).toBe("This meeting is full");
    // The screen used to say "Meeting is full." and stop there, leaving the
    // reader to guess whether waiting would help.
    expect(presentation.detail).toContain("as soon as someone leaves");
    expect(presentation.canRetry).toBe(true);
  });

  it("tells a host whose plan already has a meeting running so, rather than calling their empty room full", () => {
    const presentation = selectJoinErrorPresentation("PLAN_LIMIT_REACHED", {
      message: "Maximum 1 concurrent meeting(s) on your plan",
    });
    expect(presentation.kind).toBe("busy");
    expect(presentation.title).toBe("You already have a meeting running");
    expect(presentation.detail).not.toContain("full");
  });

  it("does not offer retry for outcomes retrying cannot change", () => {
    for (const code of ["MEETING_ENDED", "MEETING_CLOSED", "NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"]) {
      expect(selectJoinErrorPresentation(code).canRetry).toBe(false);
    }
  });

  it("offers retry for transient outcomes", () => {
    for (const code of ["PLAN_LIMIT_REACHED", "MEETING_NOT_STARTED", "RATE_LIMITED", undefined]) {
      expect(selectJoinErrorPresentation(code).canRetry).toBe(true);
    }
  });

  it("names the retry action after what it will do", () => {
    expect(selectJoinErrorPresentation("MEETING_NOT_STARTED").retryLabel).toBe("Check again");
    expect(selectJoinErrorPresentation("MEETING_ADMISSION_DENIED").retryLabel).toBe("Ask again");
  });

  it("prefers the server's message where it carries the specific reason", () => {
    // A moderator's stated reason, or a Space-specific access rule, is more
    // useful than our generic copy — but only for the codes that produce one.
    expect(
      selectJoinErrorPresentation("MEETING_ADMISSION_DENIED", { message: "Wrong meeting, sorry!" }).detail,
    ).toBe("Wrong meeting, sorry!");
    expect(selectJoinErrorPresentation("FORBIDDEN", { message: "Members of Acme only" }).detail).toBe(
      "Members of Acme only",
    );
  });

  it("falls back to written copy when the server message is empty", () => {
    expect(selectJoinErrorPresentation("MEETING_ADMISSION_DENIED", { message: "   " }).detail).toContain(
      "declined your request",
    );
    expect(selectJoinErrorPresentation(null, { message: "" }).detail).toContain("Trying again usually works");
  });

  it("promises the Meeting page only to someone who can open it", () => {
    // A signed-out guest has no account and cannot reach the Meeting page, and
    // a guest link is the usual way into these meetings — so that dead end was
    // what most people saw.
    const guest = selectJoinErrorPresentation("MEETING_ENDED");
    expect(guest.detail).not.toContain("Meeting page");
    const member = selectJoinErrorPresentation("MEETING_ENDED", { isSignedIn: true });
    expect(member.detail).toContain("Meeting page");
  });

  it("keeps an unrecognised server message rather than discarding it", () => {
    // For an unknown code that string is the only information there is.
    expect(selectJoinErrorPresentation("SOMETHING_NEW", { message: "Upstream exploded" }).detail).toBe(
      "Upstream exploded",
    );
  });
});

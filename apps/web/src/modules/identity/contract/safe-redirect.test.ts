import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTH_REDIRECT,
  encodeAuthRedirectCookieValue,
  isSafeInternalRedirect,
  resolveAuthRedirect,
  sanitizeInternalRedirect,
} from "./safe-redirect";

describe("safe redirect helpers", () => {
  it("allows exact meeting entry URLs", () => {
    expect(isSafeInternalRedirect("/abc-defg-hij")).toBe(true);
    expect(isSafeInternalRedirect("/abc-defg-hij?source=auth#resume")).toBe(true);
  });

  it("rejects non-route meeting path variants", () => {
    expect(isSafeInternalRedirect("/abc-defg-hij/obsolete-view")).toBe(false);
    expect(isSafeInternalRedirect("/abc-defg-hij/")).toBe(false);
  });

  it("allows the concrete protected route shapes", () => {
    expect(isSafeInternalRedirect("/home")).toBe(true);
    expect(isSafeInternalRedirect("/meetings?q=planning#results")).toBe(true);
    expect(isSafeInternalRedirect("/meetings/meeting_01k0a6vp6wf5x8akz7e3r21n9c#summary")).toBe(true);
    expect(isSafeInternalRedirect("/settings?tab=security")).toBe(true);
    expect(isSafeInternalRedirect("/spaces?view=owned")).toBe(true);
    expect(isSafeInternalRedirect("/space/math-201?tab=people")).toBe(true);
    expect(isSafeInternalRedirect("/join/AbCdEfGh")).toBe(true);
    // The Whiteboards list and a single board are real routes; omitting them
    // sent everyone who signed in from a board back to /home.
    expect(isSafeInternalRedirect("/whiteboards")).toBe(true);
    expect(isSafeInternalRedirect("/whiteboards?space=math-201")).toBe(true);
    expect(
      isSafeInternalRedirect("/whiteboards/whiteboard_01k0a6vp6wf5x8akz7e3r21n9c"),
    ).toBe(true);
  });

  it("rejects stale and structurally invalid application paths", () => {
    expect(isSafeInternalRedirect("/dashboard")).toBe(false);
    expect(isSafeInternalRedirect("/home/meeting")).toBe(false);
    expect(isSafeInternalRedirect("/meetings/abc-defg-hij")).toBe(false);
    expect(isSafeInternalRedirect("/session/abc-defg-hij")).toBe(false);
    expect(isSafeInternalRedirect("/spaces/space_01k0a6vp6wf5x8akz7e3r21n9c")).toBe(false);
    expect(isSafeInternalRedirect("/space/Not-A-Slug")).toBe(false);
    expect(isSafeInternalRedirect("/meeting-links/abc-defg-hij")).toBe(false);
    expect(isSafeInternalRedirect("/meeting-links/not-a-code")).toBe(false);
    expect(isSafeInternalRedirect("/join/short")).toBe(false);
    expect(isSafeInternalRedirect("/join/toomanychars")).toBe(false);
    expect(isSafeInternalRedirect("/join/abcd1234")).toBe(false);
    expect(isSafeInternalRedirect("/dashboarding")).toBe(false);
    expect(isSafeInternalRedirect("/meetings-and-more")).toBe(false);
    expect(isSafeInternalRedirect("/whiteboards/not-an-id")).toBe(false);
    expect(isSafeInternalRedirect("/whiteboards/whiteboard_01k0a6vp6wf5x8akz7e3r21n9c/edit")).toBe(false);
  });

  it("preserves a validated path, search, and hash and defaults to home", () => {
    expect(sanitizeInternalRedirect("/meetings?q=planning#results"))
      .toBe("/meetings?q=planning#results");
    expect(resolveAuthRedirect("/dashboard")).toBe(DEFAULT_AUTH_REDIRECT);
    expect(DEFAULT_AUTH_REDIRECT).toBe("/home");
  });

  it("rejects protocol-relative and external targets", () => {
    expect(isSafeInternalRedirect("//evil.com")).toBe(false);
    expect(sanitizeInternalRedirect("https://evil.com")).toBeUndefined();
  });

  it("encodes only allowlisted redirects for cookie storage", () => {
    expect(encodeAuthRedirectCookieValue("/meetings?q=a;b#next"))
      .toBe("%2Fmeetings%3Fq%3Da%3Bb%23next");
    expect(encodeAuthRedirectCookieValue("/home; SameSite=None")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { reconcileEditAccessRequestPending } from "./protocol.ts";

describe("reconcileEditAccessRequestPending", () => {
  it("restores a pending request from authoritative room state", () => {
    expect(reconcileEditAccessRequestPending(false, true)).toBe(true);
  });

  it("clears stale local waiting state after denial or server restart", () => {
    expect(reconcileEditAccessRequestPending(false, false)).toBe(false);
    expect(reconcileEditAccessRequestPending(false, undefined)).toBe(false);
  });

  it("never shows a pending request once edit access is granted", () => {
    expect(reconcileEditAccessRequestPending(true, true)).toBe(false);
  });
});

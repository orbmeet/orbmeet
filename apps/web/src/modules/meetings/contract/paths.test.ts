import { describe, expect, it } from "vitest";
import { isMeetingDocumentPath } from "./paths";

describe("isMeetingDocumentPath", () => {
  it("matches meeting-code paths with and without sub-paths", () => {
    expect(isMeetingDocumentPath("/abc-defg-hij")).toBe(true);
    expect(isMeetingDocumentPath("/abc-defg-hij/")).toBe(true);
    expect(isMeetingDocumentPath("/abc-defg-hij/settings")).toBe(true);
  });

  it("matches the recorder surface", () => {
    expect(isMeetingDocumentPath("/recorder")).toBe(true);
    expect(isMeetingDocumentPath("/recorder/abc-defg-hij")).toBe(true);
  });

  it("rejects non-meeting documents", () => {
    expect(isMeetingDocumentPath("/")).toBe(false);
    expect(isMeetingDocumentPath("/pricing")).toBe(false);
    expect(isMeetingDocumentPath("/abc-defg-hi")).toBe(false);
    expect(isMeetingDocumentPath("/ABC-DEFG-HIJ")).toBe(false);
    expect(isMeetingDocumentPath("/abc-defg-hijk")).toBe(false);
    expect(isMeetingDocumentPath("/meetings/abc-defg-hij")).toBe(false);
    expect(isMeetingDocumentPath("/recorderfoo")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  extractMeetingCodeFromPathname,
  isMeetingCode,
} from "./meeting-path";

describe("meeting path helpers", () => {
  it("accepts canonical meeting codes", () => {
    expect(isMeetingCode("abc-defg-hij")).toBe(true);
    expect(isMeetingCode("VYF-fadu-gvw")).toBe(false);
    expect(isMeetingCode("abc-defg-hijx")).toBe(false);
  });

  it("extracts the code only from an entry path", () => {
    expect(extractMeetingCodeFromPathname("/abc-defg-hij")).toBe("abc-defg-hij");
    expect(extractMeetingCodeFromPathname("/abc-defg-hij/2026-07-17-14-30")).toBeNull();
    expect(extractMeetingCodeFromPathname("/abc-defg-hij?x=1")).toBeNull();
    expect(extractMeetingCodeFromPathname("/abc-defg-hij/child")).toBeNull();
  });
});

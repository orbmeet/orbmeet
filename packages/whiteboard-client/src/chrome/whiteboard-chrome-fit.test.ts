import { describe, expect, it } from "vitest";
import { resolveWhiteboardChrome } from "./whiteboard-chrome-fit";

describe("resolveWhiteboardChrome", () => {
  it("gives every tablet and desktop board the palette, whatever its width or way up", () => {
    expect(resolveWhiteboardChrome({ isPhone: false, isPhonePortrait: false })).toMatchObject({
      mode: "regular",
      isMeetingPhonePortrait: false,
    });
  });

  it("keeps the compact kit on a phone in either orientation", () => {
    expect(resolveWhiteboardChrome({ isPhone: true, isPhonePortrait: false })).toMatchObject({
      mode: "compact",
      isMeetingPhonePortrait: false,
    });
    expect(resolveWhiteboardChrome({ isPhone: true, isPhonePortrait: true })).toMatchObject({
      mode: "compact",
      isMeetingPhonePortrait: true,
    });
  });

  it("carries whether there are tools at all", () => {
    expect(
      resolveWhiteboardChrome({ isPhone: false, isPhonePortrait: false, toolbarVisible: false }).toolbarVisible,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  CHROME_GAP_PX,
  DESKTOP_TOP_BAR_CLEARANCE_PX,
  DESKTOP_TOP_BAR_HEIGHT_PX,
  PHONE_DOCK_CLEARANCE_PX,
  PHONE_DOCK_HEIGHT_PX,
  PHONE_HEADER_CLEARANCE_PX,
  PHONE_MODE_SWITCH_HEIGHT_PX,
  selectMeetingChromeInsets,
} from "./chrome";

describe("selectMeetingChromeInsets", () => {
  it("reserves the phone header and dock when both are mounted", () => {
    expect(
      selectMeetingChromeInsets({ isPhone: true, hasDock: true, hasHeader: true }),
    ).toEqual({
      top: PHONE_HEADER_CLEARANCE_PX,
      bottom: PHONE_DOCK_CLEARANCE_PX,
    });
  });

  it("releases the bottom band while a sheet hides the dock", () => {
    // A bottom sheet owns the screen and the dock unmounts; the stage should
    // reclaim that space rather than keep an 80px hole nothing is covering.
    expect(
      selectMeetingChromeInsets({ isPhone: true, hasDock: false, hasHeader: true }),
    ).toEqual({ top: PHONE_HEADER_CLEARANCE_PX, bottom: 0 });
  });

  it("puts every desktop control in the top bar and reserves no bottom band", () => {
    // A tablet in landscape rests on the hand holding it. Nothing pressable may
    // live along the bottom edge, so desktop chrome is top-only even if a dock
    // is passed.
    expect(
      selectMeetingChromeInsets({ isPhone: false, hasDock: true, hasHeader: true }),
    ).toEqual({ top: DESKTOP_TOP_BAR_CLEARANCE_PX, bottom: 0 });
    expect(
      selectMeetingChromeInsets({ isPhone: false, hasDock: false, hasHeader: true }),
    ).toEqual({ top: DESKTOP_TOP_BAR_CLEARANCE_PX, bottom: 0 });
  });

  it("reserves exactly the solid top bar's height", () => {
    expect(DESKTOP_TOP_BAR_CLEARANCE_PX).toBe(DESKTOP_TOP_BAR_HEIGHT_PX);
  });

  it("reserves nothing for a headless render", () => {
    // Egress/recorder composites have no chrome at all; any reserved band would
    // show up as a black bar in the recording.
    expect(
      selectMeetingChromeInsets({ isPhone: true, hasDock: false, hasHeader: false }),
    ).toEqual({ top: 0, bottom: 0 });
  });

  it("keeps dock clearance symmetric around the dock", () => {
    // The dock floats: one gap to the safe-area edge below, one to content
    // above. Losing either is what previously let content slide under it.
    expect(PHONE_DOCK_CLEARANCE_PX).toBe(PHONE_DOCK_HEIGHT_PX + CHROME_GAP_PX * 2);
  });

  it("reserves the phone header's Talk | Board row while there is one", () => {
    expect(
      selectMeetingChromeInsets({ isPhone: true, hasDock: true, hasHeader: true, hasModeSwitch: true }).top,
    ).toBe(PHONE_HEADER_CLEARANCE_PX + PHONE_MODE_SWITCH_HEIGHT_PX);
  });
});

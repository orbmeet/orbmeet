import { describe, expect, it } from "vitest";

import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import {
  getFitRelativeZoom,
  getFitWidthZoom,
  getWhiteboardViewportInsets,
} from "./viewport-model";
import {
  WHITEBOARD_CONTROLS_BAND_PX,
  WHITEBOARD_EDGE_INSET_PX,
  WHITEBOARD_PHONE_LANDSCAPE_INSETS,
  WHITEBOARD_PAGER_BAND_PX,
  WHITEBOARD_PALETTE_BAND_PX,
  WHITEBOARD_TOOLBAR_HEIGHT,
  VIEWPORT_CONTROLS_BOTTOM_OFFSET_PX,
  VIEWPORT_CONTROLS_GAP_PX,
} from "./viewport-insets";
import type { WhiteboardChromeConfig } from "../chrome/whiteboard-chrome";

const dimensions = {
  pageWidth: WHITEBOARD_CONFIG.PAGE_WIDTH,
  cameraPadding: WHITEBOARD_CONFIG.CAMERA_PADDING,
};
const compactInMeeting: WhiteboardChromeConfig = {
  mode: "compact",
  toolbarVisible: true,
  isMeetingPhonePortrait: true,
  pageRailVisible: false,
  sideways: false,
};
const compactStandalone: WhiteboardChromeConfig = {
  mode: "compact",
  toolbarVisible: true,
  isMeetingPhonePortrait: false,
  pageRailVisible: false,
  sideways: false,
};
const regularWithoutToolbar: WhiteboardChromeConfig = {
  mode: "regular",
  toolbarVisible: false,
  isMeetingPhonePortrait: false,
  pageRailVisible: false,
  sideways: false,
};

const regularWithPageRail: WhiteboardChromeConfig = {
  mode: "regular",
  toolbarVisible: true,
  isMeetingPhonePortrait: false,
  pageRailVisible: true,
  sideways: false,
};

describe("viewport model", () => {
  it("reserves the palette's band on the left of a writer's page, the controls band above it, and only the edge gap elsewhere", () => {
    expect(
      getWhiteboardViewportInsets(dimensions)
    ).toEqual({
      left: WHITEBOARD_PALETTE_BAND_PX,
      right: WHITEBOARD_EDGE_INSET_PX,
      top: WHITEBOARD_CONTROLS_BAND_PX,
      bottom: WHITEBOARD_EDGE_INSET_PX,
    });
  });

  it("leaves the page rail out of the insets: it is outside the canvas container", () => {
    expect(
      getWhiteboardViewportInsets(dimensions, regularWithPageRail),
    ).toEqual(getWhiteboardViewportInsets(dimensions));
  });

  // The cell's size never decides the bands: a desktop board narrowed by the
  // meeting's side column, or shortened by the faces under it, keeps its
  // palette and its top band. Only where the controls stand does.
  it("keeps a regular board's bands whatever shape its cell is", () => {
    const regular = getWhiteboardViewportInsets(dimensions);
    expect(regular.left).toBe(WHITEBOARD_PALETTE_BAND_PX);
    expect(regular.top).toBe(WHITEBOARD_CONTROLS_BAND_PX);
    expect(regular.bottom).toBe(WHITEBOARD_EDGE_INSET_PX);
  });

  // The bottom inset covers overlays inside the whiteboard cell, and compact
  // portrait has exactly one: the pager dock. The meeting dock below it is the
  // stage rect's job. Reserving it here too cost ~80px of board for furniture
  // that was already accounted for, so a meeting board and a standalone board
  // now reserve the same band.
  it("reserves only the pager band below a compact portrait page", () => {
    const insets = {
      left: 16,
      right: 16,
      top: 40 + WHITEBOARD_TOOLBAR_HEIGHT.compact,
      bottom: WHITEBOARD_PAGER_BAND_PX,
    };
    expect(
      getWhiteboardViewportInsets(dimensions, compactInMeeting)
    ).toEqual(insets);
    expect(
      getWhiteboardViewportInsets(dimensions, compactStandalone)
    ).toEqual(insets);
  });

  // While following or presenting, status pills stack over the pager; the
  // controls measure the dock and the band grows to clear it — never shrinking
  // below the pager's own band.
  it("grows the compact portrait bottom band to the measured dock", () => {
    const pills = 110;
    expect(
      getWhiteboardViewportInsets(dimensions, { ...compactInMeeting, controlsHeightPx: pills }).bottom,
    ).toBe(VIEWPORT_CONTROLS_BOTTOM_OFFSET_PX + pills + VIEWPORT_CONTROLS_GAP_PX);
    expect(
      getWhiteboardViewportInsets(dimensions, { ...compactInMeeting, controlsHeightPx: 1 }).bottom,
    ).toBe(WHITEBOARD_PAGER_BAND_PX);
    // A dock height has no say where there is no dock.
    expect(
      getWhiteboardViewportInsets(dimensions, { ...regularWithPageRail, controlsHeightPx: pills }).bottom,
    ).toBe(WHITEBOARD_EDGE_INSET_PX);
  });

  // A board too narrow for the page controls and the presenting pill on one
  // line wraps them to a second row; the top band clears both, never less than one.
  it("grows a regular board's top band to the measured controls", () => {
    const twoRows = 80;
    expect(
      getWhiteboardViewportInsets(dimensions, { ...regularWithPageRail, controlsHeightPx: twoRows }).top,
    ).toBe(twoRows + 16);
    expect(
      getWhiteboardViewportInsets(dimensions, { ...regularWithPageRail, controlsHeightPx: 36 }).top,
    ).toBe(WHITEBOARD_CONTROLS_BAND_PX);
    expect(
      getWhiteboardViewportInsets(dimensions, { ...regularWithPageRail, controlsHeightPx: 1 }).top,
    ).toBe(WHITEBOARD_CONTROLS_BAND_PX);
  });

  it("reserves the bottom-corner capsule and the toolbar above a board held on its side", () => {
    const sideways = { ...compactStandalone, sideways: true };
    expect(getWhiteboardViewportInsets(dimensions, sideways)).toEqual({
      left: 40,
      right: 40,
      top: 40 + WHITEBOARD_TOOLBAR_HEIGHT.compact,
      bottom: WHITEBOARD_PHONE_LANDSCAPE_INSETS.bottom,
    });
    // A desktop window too short for the top band lays its controls out the same way.
    expect(getWhiteboardViewportInsets(dimensions, { ...regularWithPageRail, sideways: true })).toEqual({
      left: 40,
      right: 40,
      top: 40 + WHITEBOARD_TOOLBAR_HEIGHT.regular,
      bottom: WHITEBOARD_PHONE_LANDSCAPE_INSETS.bottom,
    });
  });

  it("keeps a reader's top band for the controls and the edit-access request, and no palette band", () => {
    expect(
      getWhiteboardViewportInsets(dimensions,
        regularWithoutToolbar,
      )
    ).toEqual({
      left: WHITEBOARD_EDGE_INSET_PX,
      right: WHITEBOARD_EDGE_INSET_PX,
      top: Math.max(WHITEBOARD_CONTROLS_BAND_PX, WHITEBOARD_TOOLBAR_HEIGHT.regular),
      bottom: WHITEBOARD_EDGE_INSET_PX,
    });
  });

  it("computes fit-width zoom from the padded viewport width", () => {
    expect(
      getFitWidthZoom({ width: 1600 }, dimensions)
    ).toBeCloseTo((1600 - 80) / 1200, 6);
  });

  it("reports zoom relative to the automatic fit-width view", () => {
    expect(getFitRelativeZoom(1.5, 1)).toBe(1.5);
    expect(getFitRelativeZoom(1.5, 0)).toBe(1);
  });

});

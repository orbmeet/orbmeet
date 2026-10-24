import { describe, expect, it } from "vitest";
import { selectContentPanel, selectRoomLayout, type RoomLayoutInput } from "./room-layout";

const desktop: RoomLayoutInput = {
  usesBottomSheets: false,
  isPhone: false,
  isLandscape: true,
  contentOnStage: false,
  panel: null,
};

describe("selectRoomLayout", () => {
  it("puts the faces on the stage in Talk, with Chat and People beside it", () => {
    expect(selectRoomLayout(desktop)).toEqual({
      tabs: ["timeline", "people"],
      active: null,
      placement: null,
      faces: "stage",
    });
    expect(selectRoomLayout({ ...desktop, panel: "timeline" })).toMatchObject({
      active: "timeline",
      placement: "side",
      faces: "stage",
    });
  });

  it("opens People in Talk on a wide screen as a list beside the faces", () => {
    expect(selectRoomLayout({ ...desktop, panel: "people" })).toMatchObject({
      active: "people",
      placement: "side",
      faces: "stage",
    });
  });

  it("keeps the faces in a column beside the board while no panel is open", () => {
    const board = { ...desktop, contentOnStage: true };
    expect(selectRoomLayout(board)).toMatchObject({ active: null, placement: null, faces: "column" });
  });

  it("puts the faces over whichever panel is open beside the board", () => {
    const board = { ...desktop, contentOnStage: true };
    expect(selectRoomLayout({ ...board, panel: "timeline" })).toEqual({
      tabs: ["timeline", "people"],
      active: "timeline",
      placement: "side",
      faces: "column",
    });
    expect(selectRoomLayout({ ...board, panel: "people" })).toMatchObject({
      active: "people",
      placement: "side",
      faces: "column",
    });
  });

  it("docks an upright tablet's panel under the content, the same panel turned", () => {
    const upright = { ...desktop, usesBottomSheets: true, isLandscape: false, contentOnStage: true };
    expect(selectRoomLayout({ ...upright, panel: "people" })).toEqual({
      tabs: ["people", "timeline"],
      active: "people",
      placement: "below",
      faces: "panel",
    });
    // The Conversation under the board: the faces are a row between them.
    expect(selectRoomLayout({ ...upright, panel: "timeline" })).toMatchObject({ placement: "below", faces: "row" });
    expect(selectRoomLayout(upright)).toMatchObject({ placement: null, faces: "row" });
  });

  it("docks an upright tablet's Conversation under Talk's stage, and keeps People a sheet", () => {
    const upright = { ...desktop, usesBottomSheets: true, isLandscape: false };
    expect(selectRoomLayout({ ...upright, panel: "timeline" })).toMatchObject({
      tabs: ["timeline"],
      active: "timeline",
      placement: "below",
      faces: "stage",
    });
    expect(selectRoomLayout({ ...upright, panel: "people" })).toMatchObject({ active: null, placement: null });
  });

  it("puts an upright phone's faces in a row under its board, with its panels as sheets", () => {
    const phone = { ...desktop, usesBottomSheets: true, isPhone: true, isLandscape: false, contentOnStage: true };
    expect(selectRoomLayout({ ...phone, panel: "people" })).toEqual({
      tabs: [],
      active: null,
      placement: null,
      faces: "row",
    });
  });

  it("gives a phone on its side the whole board", () => {
    const phone = { ...desktop, usesBottomSheets: true, isPhone: true, isLandscape: true, contentOnStage: true };
    expect(selectRoomLayout(phone).faces).toBe("none");
  });
});

describe("selectContentPanel", () => {
  it("opens People under an upright tablet's board", () => {
    expect(selectContentPanel({ isPhone: false, usesBottomSheets: true })).toBe("people");
  });

  it("opens the Conversation beside a wide screen's board, under the faces", () => {
    expect(selectContentPanel({ isPhone: false, usesBottomSheets: false })).toBe("timeline");
  });

  it("opens nothing over a phone's board", () => {
    expect(selectContentPanel({ isPhone: true, usesBottomSheets: true })).toBeNull();
  });
});

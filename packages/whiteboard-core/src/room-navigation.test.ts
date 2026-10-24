import { describe, expect, it } from "vitest";
import {
  createRoomNavigation,
  isRoomNavigationRecord,
  ROOM_NAVIGATION_ID,
  roomNavigationValidator,
} from "./room-navigation.ts";
import { isDocumentRecordId } from "./room-snapshot-validation.ts";
import { whiteboardTLSchema } from "./room-schema.ts";
import { WHITEBOARD_CONFIG } from "./config.ts";

describe("the room's navigation record", () => {
  it("is a document record the room's schema knows, under one id", () => {
    expect(isDocumentRecordId(ROOM_NAVIGATION_ID)).toBe(true);
    expect((whiteboardTLSchema.types as Record<string, { scope: string }>).orbmeet_navigation?.scope).toBe("document");
    expect(isRoomNavigationRecord(createRoomNavigation())).toBe(true);
  });

  it("validates what a presenter writes", () => {
    const record = createRoomNavigation({ pageId: "shape:page_2", pageNumber: 2, presenterId: "user_1", roam: true });
    expect(roomNavigationValidator.validate(record)).toEqual(record);
    expect(roomNavigationValidator.validate(createRoomNavigation())).toEqual(createRoomNavigation());
  });

  it("refuses a page number out of range, an unbounded id, another id, or an unknown field", () => {
    const valid = createRoomNavigation({ pageId: "shape:page_2", pageNumber: 2, presenterId: "user_1" });
    expect(() => roomNavigationValidator.validate({ ...valid, pageNumber: 0 })).toThrow();
    expect(() => roomNavigationValidator.validate({ ...valid, pageNumber: WHITEBOARD_CONFIG.MAX_PAGES + 1 })).toThrow();
    expect(() => roomNavigationValidator.validate({ ...valid, pageNumber: 1.5 })).toThrow();
    expect(() => roomNavigationValidator.validate({ ...valid, pageId: "x".repeat(257) })).toThrow();
    expect(() => roomNavigationValidator.validate({ ...valid, presenterId: "" })).toThrow();
    expect(() => roomNavigationValidator.validate({ ...valid, id: "orbmeet_navigation:other" })).toThrow();
    expect(() => roomNavigationValidator.validate({ ...valid, rect: { x: 0, y: 0, w: 1, h: 1 } })).toThrow();
  });
});

import type { BaseRecord, RecordId } from "@tldraw/store";
import type { CustomRecordInfo } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import { WHITEBOARD_CONFIG } from "./config.ts";

/**
 * Where the room is: the page its presenter is on, as a synced document
 * record.
 *
 * It travels on the same ordered socket as the document itself, so a page and
 * the navigation that points at it arrive in order, a reconnect re-syncs it
 * with everything else, and the room persists it with the board. Followers
 * are shown the presenter's page whole (see `CameraDirector`); where on the
 * page the presenter is looking stays the presenter's, so it is not here.
 *
 * Written by the active navigator (the navigation controller, else a
 * manager): the room's authorizer holds every write to that, and to
 * `presenterId` naming the session that wrote it. The room writes it too, when
 * a page add or import by the active navigator moves everyone to the new page.
 */
export const ROOM_NAVIGATION_TYPE = "orbmeet_navigation" as const;

export interface RoomNavigationRecord
  extends BaseRecord<typeof ROOM_NAVIGATION_TYPE, RecordId<RoomNavigationRecord>> {
  /** The page frame the room is on; null before anyone has presented. */
  pageId: string | null;
  /** That page's number when it was written: where followers land if it is deleted. */
  pageNumber: number;
  /** The user id of the session that wrote it; null when the room itself did. */
  presenterId: string | null;
  /** The presenter has let everyone look around on their own. */
  roam: boolean;
}

declare module "@tldraw/tlschema" {
  export interface TLGlobalRecordPropsMap {
    [ROOM_NAVIGATION_TYPE]: RoomNavigationRecord;
  }
}

/** The room has one navigation, under this id. */
export const ROOM_NAVIGATION_ID = `${ROOM_NAVIGATION_TYPE}:room` as RecordId<RoomNavigationRecord>;

const MAX_NAVIGATION_ID_LENGTH = 256;

const boundedId = T.string.check((value) => {
  if (value.length === 0 || value.length > MAX_NAVIGATION_ID_LENGTH) {
    throw new Error(`Expected an id of 1..${MAX_NAVIGATION_ID_LENGTH} characters`);
  }
});

const pageNumber = T.integer.check((value) => {
  if (value < 1 || value > WHITEBOARD_CONFIG.MAX_PAGES) {
    throw new Error(`Expected a page number in 1..${WHITEBOARD_CONFIG.MAX_PAGES}`);
  }
});

export const roomNavigationValidator: T.Validator<RoomNavigationRecord> = T.object({
  id: T.literal(ROOM_NAVIGATION_ID),
  typeName: T.literal(ROOM_NAVIGATION_TYPE),
  pageId: boundedId.nullable(),
  pageNumber,
  presenterId: boundedId.nullable(),
  roam: T.boolean,
});

export const ROOM_NAVIGATION_RECORD_INFO: CustomRecordInfo = {
  scope: "document",
  validator: roomNavigationValidator,
};

/** The record as it stands before anyone has presented. */
export function createRoomNavigation(
  fields: Partial<Omit<RoomNavigationRecord, "id" | "typeName">> = {},
): RoomNavigationRecord {
  return {
    id: ROOM_NAVIGATION_ID,
    typeName: ROOM_NAVIGATION_TYPE,
    pageId: null,
    pageNumber: 1,
    presenterId: null,
    roam: false,
    ...fields,
  };
}

export function isRoomNavigationRecord(value: unknown): value is RoomNavigationRecord {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { typeName?: unknown }).typeName === ROOM_NAVIGATION_TYPE
  );
}

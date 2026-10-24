import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDefaultUserPresence = vi.hoisted(() => vi.fn(() => ({
  id: "instance_presence:test",
  typeName: "instance_presence",
  userId: "user:test",
  userName: "Test",
  lastActivityTimestamp: 1,
  color: "#000000",
  camera: { x: 1, y: 2, z: 1 },
  selectedShapeIds: ["shape:test"],
  currentPageId: "page:test",
  brush: { x: 0, y: 0, w: 1, h: 1 },
  scribbles: [{ points: [] }],
  screenBounds: { x: 0, y: 0, w: 100, h: 100 },
  followingUserId: "user:other",
  cursor: { x: 10, y: 20, rotation: 0, type: "default" },
  chatMessage: "hello",
  meta: {},
})));

vi.mock("tldraw", () => ({ getDefaultUserPresence }));

import {
  createPresenceActivity,
  presenceWhileActive,
  PRESENCE_LINGER_MS,
  PRESENCE_RESYNC_META_KEY,
} from "./presence-activity";

const store = {} as never;
const user = {} as never;

describe("presence activity", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("broadcasts nothing until the user does something", () => {
    const activity = createPresenceActivity();

    // The bug that started this: a parked pointer drew a coloured arrow below
    // the page on everyone else's screen, from someone who was only watching.
    expect(activity.active.get()).toBe(false);
    expect(presenceWhileActive(activity, store, user)).toMatchObject({
      cursor: null,
      camera: null,
      selectedShapeIds: [],
    });
  });

  it("does not report pointer activity while quiet", () => {
    vi.setSystemTime(5_000);
    const activity = createPresenceActivity();

    // Hovering stamps the pointer's activity time; a quiet presence must not
    // pass it on, or the room learns who is moving a mouse over the board.
    expect(presenceWhileActive(activity, store, user)).toMatchObject({ lastActivityTimestamp: null });

    activity.begin();
    expect(presenceWhileActive(activity, store, user)).toMatchObject({ lastActivityTimestamp: 1 });

    activity.end();
    vi.advanceTimersByTime(PRESENCE_LINGER_MS);
    expect(presenceWhileActive(activity, store, user)).toMatchObject({
      lastActivityTimestamp: 5_000 + PRESENCE_LINGER_MS,
    });
  });

  it("broadcasts while the pointer is down", () => {
    const activity = createPresenceActivity();
    activity.begin();

    expect(activity.active.get()).toBe(true);
  });

  it("lingers after the pointer lifts, then goes quiet", () => {
    const activity = createPresenceActivity();
    activity.begin();
    activity.end();

    // Still there a moment later: lifting the pen between two strokes of one
    // letter must not blink your cursor out of the room.
    vi.advanceTimersByTime(PRESENCE_LINGER_MS - 1);
    expect(activity.active.get()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(activity.active.get()).toBe(false);
    expect(presenceWhileActive(activity, store, user)).toMatchObject({
      cursor: null,
      camera: null,
      screenBounds: null,
      selectedShapeIds: [],
      brush: null,
      scribbles: [],
    });
  });

  it("a new stroke inside the linger cancels the fade", () => {
    const activity = createPresenceActivity();
    activity.begin();
    activity.end();
    vi.advanceTimersByTime(PRESENCE_LINGER_MS - 10);
    activity.begin();

    vi.advanceTimersByTime(PRESENCE_LINGER_MS);
    expect(activity.active.get()).toBe(true);
  });

  it("stops broadcasting immediately when the board unmounts", () => {
    const activity = createPresenceActivity();
    activity.begin();
    activity.dispose();

    expect(activity.active.get()).toBe(false);
    // And the pending fade cannot fire against a disposed board.
    vi.advanceTimersByTime(PRESENCE_LINGER_MS * 2);
    expect(activity.active.get()).toBe(false);
  });

  it("is a signal, so the presence derivation re-reads it", () => {
    const activity = createPresenceActivity();
    // A plain boolean would be captured once by the reactive derivation
    // `getUserPresence` runs inside, and the cursor would never come back.
    expect(typeof activity.active.get).toBe("function");
    activity.begin();
    expect(activity.active.get()).toBe(true);
  });

  it("carries nothing in meta until the room asks for a resync", () => {
    const activity = createPresenceActivity();
    activity.begin();

    expect(presenceWhileActive(activity, store, user)?.meta).toEqual({});
  });

  it("changes its presence when the room asks for a resync, active or quiet", () => {
    const activity = createPresenceActivity();
    const quiet = presenceWhileActive(activity, store, user);

    // The room dropped an update and answered it: only a change of this
    // client's presence carries the whole record to its peers again.
    activity.resync();
    const resynced = presenceWhileActive(activity, store, user);
    expect(resynced?.meta).toEqual({ [PRESENCE_RESYNC_META_KEY]: 1 });
    expect(resynced).not.toEqual(quiet);

    activity.resync();
    activity.begin();
    expect(presenceWhileActive(activity, store, user)?.meta).toEqual({ [PRESENCE_RESYNC_META_KEY]: 2 });
  });
});

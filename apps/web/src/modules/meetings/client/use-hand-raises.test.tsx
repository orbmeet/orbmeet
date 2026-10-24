// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Room } from "livekit-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PARTICIPANT_ATTRIBUTE, formatRaisedHand } from "@/modules/meetings/contract/live-state";

vi.mock("@/modules/meetings/server/runtime/live.functions", () => ({
  raiseHand: vi.fn(),
  lowerHand: vi.fn(),
  resolveHandRaise: vi.fn(),
}));

const { useHandRaises } = await import("./use-hand-raises");

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

/** A room where one attendee raised their hand at `raisedAt`, in the server's time. */
function roomWithHand(raisedAt: number) {
  const room = new EventEmitter() as EventEmitter & Record<string, unknown>;
  // Real participants are EventEmitters; useParticipants' observable subscribes
  // to media/permission events on them directly.
  const attendee = Object.assign(new EventEmitter(), {
    identity: "bob_connection_1",
    name: "Bob",
    attributes: { [PARTICIPANT_ATTRIBUTE.hand]: formatRaisedHand({ raiseId: "raise_1", raisedAt }) },
    // useParticipants' participant observable reads the track publications on
    // every emission; these fakes carry no tracks at all.
    getTrackPublication: () => undefined,
  });
  Object.assign(room, {
    localParticipant: Object.assign(new EventEmitter(), {
      identity: "ada_connection_1",
      attributes: {},
      getTrackPublication: () => undefined,
    }),
    remoteParticipants: new Map([[attendee.identity, attendee]]),
  });
  return room as unknown as Room;
}

function watch(room: Room, props: { canModerate: boolean; serverClockOffsetMs: number }) {
  let latest: ReturnType<typeof useHandRaises> | null = null;
  function Probe(current: typeof props) {
    latest = useHandRaises({ room, meetingId: "meeting_1", connectionId: "connection_1", ...current });
    return null;
  }
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(<Probe {...props} />));
  return () => latest!;
}

describe("useHandRaises", () => {
  it("announces a hand raised after a moderator with a fast clock started watching", () => {
    // The moderator's clock runs two minutes ahead of the server's.
    const offset = -2 * 60_000;
    const serverNow = Date.now() + offset;
    const hands = watch(roomWithHand(serverNow + 1_000), { canModerate: true, serverClockOffsetMs: offset });
    expect(hands().handRaiseQueue[0]?.replayed).toBe(false);
  });

  it("treats hands already waiting when an attendee is promoted as waiting, not news", () => {
    const room = roomWithHand(Date.now() + 1_000);
    watch(room, { canModerate: false, serverClockOffsetMs: 0 });
    const hands = watch(room, { canModerate: true, serverClockOffsetMs: 5_000 });
    expect(hands().handRaiseQueue[0]?.replayed).toBe(true);
  });
});

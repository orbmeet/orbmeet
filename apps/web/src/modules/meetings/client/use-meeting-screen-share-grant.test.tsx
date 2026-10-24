// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RoomEvent, Track, type Room } from "livekit-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PARTICIPANT_ATTRIBUTE } from "@/modules/meetings/contract/live-state";

const stopScreenShare = vi.fn(async () => ({ kind: "ok" }));
const requestScreenShare = vi.fn(async () => ({ kind: "ok" }));
vi.mock("@/modules/meetings/server/runtime/live.functions", () => ({
  stopScreenShare,
  requestScreenShare,
  decideScreenShare: vi.fn(),
}));
vi.mock("@/lib/browser-capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/browser-capabilities")>()),
  canCaptureDisplay: () => true,
}));

const { useMeetingScreenShare } = await import("./use-meeting-screen-share");

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
});

/** An attendee's room: what the coordinator grants arrives as attributes and permissions. */
function attendeeRoom() {
  const room = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const screenTrack = {
    kind: Track.Kind.Video,
    stop: vi.fn(),
    mediaStreamTrack: new EventTarget(),
  };
  // A real participant is an EventEmitter; useParticipants' observable
  // subscribes to media/permission events on it directly.
  const localParticipant = Object.assign(new EventEmitter(), {
    identity: "ada_connection_1",
    attributes: {},
    permissions: { canPublishSources: [] as number[] },
    isScreenShareEnabled: false,
    // useParticipants' participant observable reads the track publications on
    // every emission; this fake carries no tracks at all.
    getTrackPublication: () => undefined,
    createScreenTracks: vi.fn(async () => [screenTrack]),
    publishTrack: vi.fn(async () => ({})),
    unpublishTrack: vi.fn(),
  });
  Object.assign(room, { localParticipant, remoteParticipants: new Map(), state: "connected" });
  return {
    room: room as unknown as Room,
    localParticipant,
    /** The coordinator records the request, then a moderator's grant. */
    serverSets(value: "requested" | "granted") {
      localParticipant.attributes = { [PARTICIPANT_ATTRIBUTE.screenShare]: value };
      if (value === "granted") {
        localParticipant.permissions = { canPublishSources: [Track.sourceToProto(Track.Source.ScreenShare)] };
        room.emit(RoomEvent.ParticipantPermissionsChanged, undefined, localParticipant);
      }
      room.emit(RoomEvent.ParticipantAttributesChanged, {}, localParticipant);
    },
  };
}

describe("an approved attendee's screen share", () => {
  it("keeps the grant it publishes with", async () => {
    const { room, localParticipant, serverSets } = attendeeRoom();
    let latest: ReturnType<typeof useMeetingScreenShare> | null = null;
    function Probe() {
      latest = useMeetingScreenShare({
        roomInstance: room,
        canModerate: false,
        meetingId: "meeting_1",
        connectionId: "connection_1",
        addToast: vi.fn(),
      });
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Probe />));

    // Pick a screen, which sends the request.
    await act(async () => {
      await latest!.handleToggleScreenShare();
    });
    expect(requestScreenShare).toHaveBeenCalledTimes(1);
    act(() => serverSets("requested"));

    // A moderator approves: the prepared screen publishes on the grant.
    await act(async () => {
      serverSets("granted");
      await Promise.resolve();
    });
    expect(localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    // Publishing must not give back the grant it depends on.
    expect(stopScreenShare).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { DisconnectReason } from "livekit-client";
import { getMeetingDisconnectDisposition } from "./disconnect";

describe("getMeetingDisconnectDisposition", () => {
  it("treats room shutdown as an ended meeting", () => {
    expect(getMeetingDisconnectDisposition(DisconnectReason.ROOM_DELETED, true)).toEqual({ kind: "ended" });
    expect(getMeetingDisconnectDisposition(DisconnectReason.ROOM_CLOSED, true)).toEqual({ kind: "ended" });
  });

  it("does not auto-rejoin after a duplicate identity", () => {
    expect(
      getMeetingDisconnectDisposition(DisconnectReason.DUPLICATE_IDENTITY, true),
    ).toMatchObject({ kind: "terminal" });
  });

  it("asks why after a removal instead of rejoining blindly", () => {
    expect(
      getMeetingDisconnectDisposition(DisconnectReason.PARTICIPANT_REMOVED, true),
    ).toEqual({ kind: "removed" });
  });

  it("ignores a connection that never connected", () => {
    expect(getMeetingDisconnectDisposition(undefined, false)).toEqual({ kind: "ignore" });
    expect(getMeetingDisconnectDisposition(DisconnectReason.CLIENT_INITIATED, false)).toEqual({ kind: "ignore" });
  });

  it("rejoins after LiveKit disconnected a frozen or hidden page itself", () => {
    expect(getMeetingDisconnectDisposition(DisconnectReason.CLIENT_INITIATED, true)).toEqual({ kind: "rejoin", nodeLost: false });
  });

  it("rejoins after an unclassified transport disconnect", () => {
    expect(getMeetingDisconnectDisposition(undefined, true)).toEqual({ kind: "rejoin", nodeLost: true });
  });
});

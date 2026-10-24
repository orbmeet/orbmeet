import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@livekit/rtc-node", () => ({
  RoomEvent: { ParticipantDisconnected: "participantDisconnected", Disconnected: "disconnected" },
}));

import type { Room } from "@livekit/rtc-node";
import { waitForDeparture } from "./departure.js";

function room() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isConnected: true,
    remoteParticipants: new Map([["publisher", { identity: "publisher" }]]),
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("waitForDeparture", () => {
  it("ends when LiveKit says the publisher left", async () => {
    const lk = room();
    const departed = waitForDeparture(lk as unknown as Room, "publisher");
    lk.emit("participantDisconnected", { identity: "someone-else" });
    lk.emit("participantDisconnected", { identity: "publisher" });
    await expect(departed).resolves.toBe("publisher left the room");
    expect(lk.listenerCount("participantDisconnected")).toBe(0);
  });

  it("ends at once when the publisher is already gone", async () => {
    const lk = room();
    lk.remoteParticipants.clear();
    await expect(waitForDeparture(lk as unknown as Room, "publisher")).resolves.toBe("publisher left the room");
  });

  it("ends when its own connection stays down with no event, and not while it recovers", async () => {
    const lk = room();
    const outcome = vi.fn();
    void waitForDeparture(lk as unknown as Room, "publisher", { intervalMs: 1_000, disconnectedGraceMs: 10_000 }).then(outcome);

    lk.isConnected = false;
    await vi.advanceTimersByTimeAsync(5_000);
    lk.isConnected = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(outcome).not.toHaveBeenCalled();

    lk.isConnected = false;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(outcome).toHaveBeenCalledWith(expect.stringContaining("LiveKit connection down"));
  });

  it("ends when the server stops listing a publisher whose departure never arrived", async () => {
    const lk = room();
    const answers: Array<boolean | null> = [true, false, null, true, false, false];
    const checkPresence = vi.fn(async () => (answers.length > 0 ? answers.shift()! : false));
    const outcome = vi.fn();
    void waitForDeparture(lk as unknown as Room, "publisher", { intervalMs: 1_000, checkPresence }).then(outcome);

    // One miss, a check that could not tell, and a recovery do not end it.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(outcome).not.toHaveBeenCalled();
    // Two misses in a row do.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcome).toHaveBeenCalledWith("the LiveKit server no longer lists the publisher");
    const calls = checkPresence.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkPresence.mock.calls.length).toBe(calls);
  });
});

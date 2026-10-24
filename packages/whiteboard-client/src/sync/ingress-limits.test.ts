import { describe, expect, it } from "vitest";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";

// These ceilings live in three different modules on the message path
// (page-frame-guard's assembler, room.ts's RateLimiter, the room-size guard).
// The composed behaviour is only correct while they stay ordered, and a
// violation is invisible in any single module's own tests.
describe("client ingress limits", () => {
  it("lets a maximum-size assemblable message fit in one rate-limit window", () => {
    // Below this, any message the assembler accepts closes the session with
    // RATE_LIMITED — which the client treats as transient, so it reconnects,
    // re-sends the same push, and flaps indefinitely.
    //
    // Strictly greater, not >=: the limiter bills wire bytes, and chunkMessage
    // adds an "<n>_" prefix per chunk, so a message at exactly the assembly
    // ceiling costs *more* than the ceiling. Equality made the largest
    // assemblable message unconditionally fatal.
    expect(WHITEBOARD_CONFIG.CLIENT_INGRESS_BYTES_PER_SECOND).toBeGreaterThan(
      WHITEBOARD_CONFIG.MAX_CLIENT_MESSAGE_BYTES,
    );
  });

  it("leaves the largest message room to share its window with other traffic", () => {
    // The window is per-user and shared with connections/cursor pushes from every
    // tab, so the surplus has to cover more than the chunk prefixes.
    expect(
      WHITEBOARD_CONFIG.CLIENT_INGRESS_BYTES_PER_SECOND -
        WHITEBOARD_CONFIG.MAX_CLIENT_MESSAGE_BYTES,
    ).toBeGreaterThanOrEqual(WHITEBOARD_CONFIG.CLIENT_INGRESS_HEADROOM_BYTES);
  });

  it("keeps the persisted snapshot ceiling above the live write ceiling", () => {
    expect(WHITEBOARD_CONFIG.MAX_SNAPSHOT_BYTES).toBeGreaterThan(
      WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES,
    );
  });

  it("cannot admit a single message larger than the whole room may be", () => {
    expect(WHITEBOARD_CONFIG.MAX_CLIENT_MESSAGE_BYTES).toBeLessThanOrEqual(
      WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES,
    );
  });
});

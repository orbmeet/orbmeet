import { describe, expect, it, vi } from "vitest";
import { PlaybackUnlock, type PlaybackUnlockPort } from "./playback-unlock";

function createPort({ unlockedFrom }: { unlockedFrom: "start" | "gesture" | "never" }) {
  let canPlay = unlockedFrom === "start";
  let pendingGesture: (() => void) | null = null;

  const port: PlaybackUnlockPort = {
    canPlayAudio: () => canPlay,
    startAudio: vi.fn(async () => {
      // Autoplay policy: without a gesture in hand the browser refuses.
      if (unlockedFrom === "never") throw new Error("NotAllowedError");
      if (unlockedFrom === "gesture" && !insideGesture) throw new Error("NotAllowedError");
      canPlay = true;
    }),
    onNextUserGesture: vi.fn((handler: () => void) => {
      pendingGesture = handler;
      return () => {
        if (pendingGesture === handler) pendingGesture = null;
      };
    }),
  };

  let insideGesture = false;

  return {
    port,
    get armed() {
      return pendingGesture !== null;
    },
    fireGesture: () => {
      const handler = pendingGesture;
      pendingGesture = null;
      insideGesture = true;
      handler?.();
      insideGesture = false;
    },
    runInGesture: (fn: () => void) => {
      insideGesture = true;
      fn();
      insideGesture = false;
    },
  };
}

describe("PlaybackUnlock", () => {
  it("does nothing when audio is already playable", async () => {
    const harness = createPort({ unlockedFrom: "start" });
    const unlock = new PlaybackUnlock(harness.port);

    unlock.start();
    await vi.waitFor(() => expect(unlock.blocked).toBe(false));

    expect(harness.port.startAudio).not.toHaveBeenCalled();
    expect(harness.armed).toBe(false);
  });

  it("arms the next user gesture when the ungestured attempt is refused", async () => {
    const harness = createPort({ unlockedFrom: "gesture" });
    const onDiagnostic = vi.fn();
    const unlock = new PlaybackUnlock(harness.port, { onDiagnostic });

    unlock.start();
    await vi.waitFor(() => expect(harness.armed).toBe(true));
    expect(onDiagnostic).toHaveBeenCalledWith(
      "blocked",
      expect.objectContaining({ trigger: "auto" }),
    );
    expect(unlock.blocked).toBe(true);

    // The user taps anything at all — a tile, a control, the chat button.
    harness.fireGesture();
    await vi.waitFor(() => expect(unlock.blocked).toBe(false));
    expect(onDiagnostic).toHaveBeenCalledWith(
      "unlocked",
      expect.objectContaining({ trigger: "gesture" }),
    );
    expect(harness.armed).toBe(false);
  });

  it("re-arms when a gesture attempt still fails", async () => {
    const harness = createPort({ unlockedFrom: "never" });
    const unlock = new PlaybackUnlock(harness.port);

    unlock.start();
    await vi.waitFor(() => expect(harness.armed).toBe(true));

    harness.fireGesture();
    await vi.waitFor(() => expect(harness.armed).toBe(true));
    expect(unlock.blocked).toBe(true);
  });

  it("unlocks from the explicit affordance and disarms the gesture listener", async () => {
    const harness = createPort({ unlockedFrom: "gesture" });
    const onDiagnostic = vi.fn();
    const unlock = new PlaybackUnlock(harness.port, { onDiagnostic });

    unlock.start();
    await vi.waitFor(() => expect(harness.armed).toBe(true));

    // The banner button: the click handler is already a gesture.
    harness.runInGesture(() => unlock.unlockFromUserGesture());

    await vi.waitFor(() => expect(unlock.blocked).toBe(false));
    expect(onDiagnostic).toHaveBeenCalledWith(
      "unlocked",
      expect.objectContaining({ trigger: "explicit" }),
    );
    expect(harness.armed).toBe(false);
  });

  it("stops listening once disposed", async () => {
    const harness = createPort({ unlockedFrom: "gesture" });
    const unlock = new PlaybackUnlock(harness.port);

    unlock.start();
    await vi.waitFor(() => expect(harness.armed).toBe(true));

    unlock.dispose();
    expect(harness.armed).toBe(false);
  });
});

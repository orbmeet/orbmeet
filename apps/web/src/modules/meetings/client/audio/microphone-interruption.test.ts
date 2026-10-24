import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MICROPHONE_SAMPLE_INTERVAL_MS,
  MicrophoneInterruption,
  type AudioSessionState,
  type MicrophoneInterruptionDiagnostic,
  type MicrophoneInterruptionPort,
} from "./microphone-interruption";

/**
 * Models the device the way the iPad behaved: a call mutes capture and stops
 * the sender, and whether the capture comes back is up to the system or to a
 * restart that the system allows.
 */
function createDevice() {
  const state = {
    intentOn: true,
    busy: false,
    visible: true,
    trackMuted: false,
    upstreamPaused: false,
    audioSession: "active" as AudioSessionState | null,
    packets: 0,
    /** Packets per sample while capture flows. */
    flowing: true,
    /** Whether a restart gets the microphone back. */
    restartWorks: true,
  };
  let pendingGesture: (() => void) | null = null;

  const port: MicrophoneInterruptionPort = {
    intentOn: () => state.intentOn,
    busy: () => state.busy,
    observe: () => ({
      trackMuted: state.trackMuted,
      upstreamPaused: state.upstreamPaused,
      audioSession: state.audioSession,
    }),
    packetsSent: vi.fn(async () => {
      if (state.flowing) state.packets += 250;
      return state.packets;
    }),
    pageVisible: () => state.visible,
    restart: vi.fn(async () => {
      if (!state.restartWorks) throw Object.assign(new Error("Capture refused"), { name: "NotAllowedError" });
      state.trackMuted = false;
      state.upstreamPaused = false;
      state.flowing = true;
      return true;
    }),
    onNextUserGesture: vi.fn((handler: () => void) => {
      pendingGesture = handler;
      return () => {
        if (pendingGesture === handler) pendingGesture = null;
      };
    }),
  };

  return {
    state,
    port,
    /** What an incoming call does to the page's capture. */
    callArrives() {
      state.trackMuted = true;
      state.upstreamPaused = true;
      state.flowing = false;
    },
    get armed() {
      return pendingGesture !== null;
    },
    fireGesture() {
      const handler = pendingGesture;
      pendingGesture = null;
      handler?.();
    },
  };
}

function track(device: ReturnType<typeof createDevice>) {
  const diagnostics: MicrophoneInterruptionDiagnostic[] = [];
  const onStateChange = vi.fn();
  const watch = new MicrophoneInterruption(device.port, {
    onStateChange,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { watch, diagnostics, onStateChange };
}

async function samples(count: number) {
  for (let i = 0; i < count; i++) await vi.advanceTimersByTimeAsync(MICROPHONE_SAMPLE_INTERVAL_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MicrophoneInterruption", () => {
  it("stays quiet while the microphone is sending", async () => {
    const device = createDevice();
    const { watch, diagnostics } = track(device);
    watch.start();

    await samples(4);

    expect(watch.interrupted).toBe(false);
    expect(diagnostics).toEqual([]);
    expect(device.port.restart).not.toHaveBeenCalled();
    watch.dispose();
  });

  it("notices a capture the system muted, and arms the next gesture", async () => {
    const device = createDevice();
    const { watch, diagnostics } = track(device);
    watch.start();
    await samples(1);

    device.callArrives();
    await samples(1);

    expect(watch.interrupted).toBe(true);
    expect(watch.interruptionCause).toBe("device");
    expect(diagnostics[0]).toMatchObject({ event: "interrupted", cause: "device" });
    expect(device.armed).toBe(true);
    watch.dispose();
  });

  it("waits out an interrupted audio session, then restarts as soon as it ends", async () => {
    const device = createDevice();
    const { watch, diagnostics } = track(device);
    watch.start();
    await samples(1);

    device.callArrives();
    device.state.audioSession = "interrupted";
    watch.check();
    expect(watch.interruptionCause).toBe("session");

    // Ringing for a minute: no restart is worth trying while the call holds the audio.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(device.port.restart).not.toHaveBeenCalled();

    // The call ends. WebKit leaves the capture muted, and our restart brings it back.
    device.state.audioSession = "active";
    watch.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(device.port.restart).toHaveBeenCalledTimes(1);

    await samples(2);
    expect(watch.interrupted).toBe(false);
    expect(diagnostics.at(-1)).toMatchObject({
      event: "resumed",
      via: "restart",
      cause: "session",
      trigger: "auto",
    });
    expect(device.armed).toBe(false);
    watch.dispose();
  });

  it("flags a capture that stops sending without saying so", async () => {
    const device = createDevice();
    const { watch } = track(device);
    watch.start();
    await samples(1);

    device.state.flowing = false;
    await samples(1);
    expect(watch.interrupted).toBe(false);
    await samples(1);

    expect(watch.interruptionCause).toBe("silent");
    watch.dispose();
  });

  it("does not count a reconnecting link or a toggle in flight as silence", async () => {
    const device = createDevice();
    const { watch } = track(device);
    watch.start();
    await samples(1);

    device.state.flowing = false;
    device.state.busy = true;
    await samples(4);

    expect(watch.interrupted).toBe(false);
    watch.dispose();
  });

  it("keeps saying so after a restart that brings back no packets, and tries again", async () => {
    const device = createDevice();
    device.port.restart = vi.fn(async () => true); // the system hands back a dead capture
    const { watch } = track(device);
    watch.start();
    await samples(1);
    device.callArrives();
    await samples(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(device.port.restart).toHaveBeenCalledTimes(1);
    await samples(2);

    expect(watch.interrupted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((device.port.restart as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    watch.dispose();
  });

  it("reports a refused restart and keeps the gesture armed", async () => {
    const device = createDevice();
    device.state.restartWorks = false;
    const { watch, diagnostics } = track(device);
    watch.start();
    await samples(1);
    device.callArrives();
    await samples(1);

    device.fireGesture();
    await vi.advanceTimersByTimeAsync(0);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ event: "resume_failed", trigger: "gesture", attempts: 1 }),
    );
    expect(watch.interrupted).toBe(true);
    expect(device.armed).toBe(true);
    watch.dispose();
  });

  it("leaves a capture that keeps coming back muted to the backoff, whatever else changes", async () => {
    const device = createDevice();
    // The system hands back a track it still holds muted, every time.
    device.port.restart = vi.fn(async () => true);
    const { watch } = track(device);
    watch.start();
    await samples(1);
    device.callArrives();
    watch.check();

    // Reconnects, session state changes, mute toggles: each checks again, and
    // none is what recovery waits for.
    for (let i = 0; i < 20; i++) {
      watch.check();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(device.port.restart).not.toHaveBeenCalled();

    // The backoff is what retries.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(device.port.restart).toHaveBeenCalledTimes(1);
    watch.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(device.port.restart).toHaveBeenCalledTimes(1);
    watch.dispose();
  });

  it("restarts at once when a page that went hidden while interrupted is shown", async () => {
    const device = createDevice();
    const { watch } = track(device);
    watch.start();
    await samples(1);
    device.state.visible = false;
    device.callArrives();
    // Noticed by sampling, with no check while hidden.
    await samples(1);
    expect(watch.interrupted).toBe(true);
    expect(device.port.restart).not.toHaveBeenCalled();

    device.state.visible = true;
    watch.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(device.port.restart).toHaveBeenCalledTimes(1);
    watch.dispose();
  });

  it("does not restart on every stroke of a pen", async () => {
    const device = createDevice();
    device.port.restart = vi.fn(async () => true);
    const { watch } = track(device);
    watch.start();
    await samples(1);
    device.callArrives();
    device.state.audioSession = "interrupted"; // so only gestures restart
    watch.check();

    device.fireGesture();
    await vi.advanceTimersByTimeAsync(0);
    device.fireGesture();
    await vi.advanceTimersByTimeAsync(0);
    device.fireGesture();
    await vi.advanceTimersByTimeAsync(0);

    expect(device.port.restart).toHaveBeenCalledTimes(1);
    expect(device.armed).toBe(true);
    watch.dispose();
  });

  it("credits the system when the capture comes back without a restart", async () => {
    const device = createDevice();
    const { watch, diagnostics } = track(device);
    watch.start();
    await samples(1);
    device.callArrives();
    device.state.audioSession = "interrupted";
    watch.check();

    device.state.audioSession = "active";
    device.state.trackMuted = false;
    device.state.upstreamPaused = false;
    device.state.flowing = true;
    device.state.visible = false; // hidden, so no restart of ours races it
    watch.check();
    await samples(2);

    expect(device.port.restart).not.toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({ event: "resumed", via: "system", attempts: 0 });
    watch.dispose();
  });

  it("does not restart a capture the system already gave back on returning to the page", async () => {
    const device = createDevice();
    const { watch, diagnostics } = track(device);
    watch.start();
    await samples(1);
    device.state.visible = false;
    device.callArrives();
    await samples(1);
    expect(watch.interrupted).toBe(true);

    device.state.trackMuted = false;
    device.state.upstreamPaused = false;
    device.state.flowing = true;
    device.state.visible = true;
    watch.check();
    await samples(2);

    expect(device.port.restart).not.toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({ event: "resumed", via: "system" });
    watch.dispose();
  });

  it("ends when the user mutes, and never restarts a muted microphone", async () => {
    const device = createDevice();
    const { watch, diagnostics } = track(device);
    watch.start();
    await samples(1);
    device.callArrives();
    device.state.audioSession = "interrupted";
    watch.check();

    device.state.intentOn = false;
    watch.check();

    expect(watch.interrupted).toBe(false);
    expect(diagnostics.at(-1)).toMatchObject({ event: "resumed", via: "muted" });
    device.state.audioSession = "active";
    watch.check();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(device.port.restart).not.toHaveBeenCalled();
    watch.dispose();
  });

  it("restarts from the explicit affordance even while the session is interrupted", async () => {
    const device = createDevice();
    const { watch } = track(device);
    watch.start();
    await samples(1);
    device.callArrives();
    device.state.audioSession = "interrupted";
    watch.check();

    watch.resumeFromUserGesture();
    await vi.advanceTimersByTimeAsync(0);

    expect(device.port.restart).toHaveBeenCalledTimes(1);
    watch.dispose();
  });

  it("stops every timer and gesture on dispose", async () => {
    const device = createDevice();
    const { watch } = track(device);
    watch.start();
    await samples(1);
    device.callArrives();
    await samples(1);

    watch.dispose();
    device.state.audioSession = "active";
    await vi.advanceTimersByTimeAsync(120_000);

    expect(device.port.restart).not.toHaveBeenCalled();
    expect(device.armed).toBe(false);
  });
});

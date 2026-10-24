import { describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";
import { MicrophoneController, type MicrophoneControllerPort } from "./microphone-controller";
import type { MicrophoneRecoveryResult } from "@/modules/meetings/client/microphone-recovery";

/**
 * Models livekit-client's derived state rather than a plain flag: a fake that
 * stores `isMicrophoneEnabled` independently cannot reproduce the bugs this
 * controller exists to prevent.
 */
function createPort({ startOn = false }: { startOn?: boolean } = {}) {
  let publicationMuted = !startOn;
  let failNextEnable: Error | null = null;

  const port: MicrophoneControllerPort = {
    get isMicrophoneEnabled() {
      return !publicationMuted;
    },
    getTrackPublication: () => ({
      get isMuted() {
        return publicationMuted;
      },
      track: {
        kind: Track.Kind.Audio,
        mediaStreamTrack: {
          get enabled() {
            return !publicationMuted;
          },
          muted: false,
          readyState: "live",
        },
      },
    }),
    setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
      if (enabled && failNextEnable) {
        const error = failNextEnable;
        failNextEnable = null;
        throw error;
      }
      publicationMuted = !enabled;
    }),
  };

  return {
    port,
    failNextEnableWith: (error: Error) => {
      failNextEnable = error;
    },
  };
}

const healthy = async (): Promise<MicrophoneRecoveryResult> => "ok";

describe("MicrophoneController", () => {
  it("publishes the microphone when intent turns on, then verifies health once", async () => {
    const { port } = createPort();
    const recover = vi.fn(healthy);
    const controller = new MicrophoneController(port, "off", { recover });

    controller.setIntent("on");
    expect(controller.intentOn).toBe(true); // optimistic: the UI flips immediately
    expect(controller.pending).toBe(true);

    await vi.waitFor(() => expect(controller.pending).toBe(false));
    expect(port.isMicrophoneEnabled).toBe(true);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("does not repair a microphone nobody has touched", async () => {
    const { port } = createPort({ startOn: true });
    const recover = vi.fn(healthy);
    const controller = new MicrophoneController(port, "on", { recover });

    await Promise.resolve();
    expect(controller.pending).toBe(false);
    expect(recover).not.toHaveBeenCalled();
    expect(port.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it("honours a mute that arrives while an unmute is still in flight", async () => {
    const { port } = createPort();
    let releaseRecover: (() => void) | undefined;
    const recover = vi.fn(
      () =>
        new Promise<MicrophoneRecoveryResult>((resolve) => {
          releaseRecover = () => resolve("ok");
        }),
    );
    const controller = new MicrophoneController(port, "off", { recover });

    controller.setIntent("on");
    await vi.waitFor(() => expect(releaseRecover).toBeDefined());

    // The click that the old busy-latch dropped on the floor.
    controller.setIntent("off");
    releaseRecover?.();

    await vi.waitFor(() => expect(controller.pending).toBe(false));
    expect(controller.intentOn).toBe(false);
    expect(port.isMicrophoneEnabled).toBe(false);
  });

  it("coalesces rapid toggling to the final intent", async () => {
    const { port } = createPort();
    const controller = new MicrophoneController(port, "off", { recover: healthy });

    controller.setIntent("on");
    controller.setIntent("off");
    controller.setIntent("on");

    await vi.waitFor(() => expect(controller.pending).toBe(false));
    expect(controller.intentOn).toBe(true);
    expect(port.isMicrophoneEnabled).toBe(true);
  });

  it("falls back to muted when the microphone cannot be enabled", async () => {
    const { port, failNextEnableWith } = createPort();
    const onFailure = vi.fn();
    const controller = new MicrophoneController(port, "off", { recover: healthy, onFailure });

    failNextEnableWith(new Error("NotReadableError"));
    controller.setIntent("on");

    await vi.waitFor(() => expect(controller.pending).toBe(false));
    expect(onFailure).toHaveBeenCalledWith("enable", expect.any(Error));
    expect(controller.intentOn).toBe(false);
    expect(port.isMicrophoneEnabled).toBe(false);
  });

  it("falls back to muted when the repair ladder gives up", async () => {
    const { port } = createPort();
    const onFailure = vi.fn();
    const recover = vi.fn(async () => {
      throw new Error("did not recover");
    });
    const controller = new MicrophoneController(port, "off", { recover, onFailure });

    controller.setIntent("on");

    await vi.waitFor(() => expect(controller.pending).toBe(false));
    expect(onFailure).toHaveBeenCalledWith("heal", expect.any(Error));
    expect(controller.intentOn).toBe(false);
    expect(port.isMicrophoneEnabled).toBe(false);
  });

  it("re-runs the repair ladder when health is invalidated, without touching intent", async () => {
    const { port } = createPort({ startOn: true });
    const recover = vi.fn(healthy);
    const controller = new MicrophoneController(port, "on", { recover });

    controller.invalidateHealth();
    await vi.waitFor(() => expect(controller.pending).toBe(false));

    expect(recover).toHaveBeenCalledTimes(1);
    expect(controller.intentOn).toBe(true);
    expect(port.isMicrophoneEnabled).toBe(true);
  });

  it("re-publishes when the repair ladder leaves the track muted", async () => {
    // The exact shape of the original bug: recovery ends with the microphone
    // off while intent is still on. Reconciliation must notice and fix it
    // rather than stranding the user muted.
    const { port } = createPort();
    const recover = vi.fn(async () => {
      await port.setMicrophoneEnabled(false);
      return "cancelled" as const;
    });
    const controller = new MicrophoneController(port, "off", { recover });

    controller.setIntent("on");
    await vi.waitFor(() => expect(controller.pending).toBe(false));

    expect(controller.intentOn).toBe(true);
    expect(port.isMicrophoneEnabled).toBe(true);
  });

  it("adopts an external mute instead of fighting it", async () => {
    // Meeting teardown mutes the track directly (stopAllLocalTracks). Without
    // adoption, reconciliation would helpfully switch the microphone back on
    // while the user is leaving the meeting.
    const { port } = createPort({ startOn: true });
    const controller = new MicrophoneController(port, "on", { recover: healthy });

    await port.setMicrophoneEnabled(false);
    controller.syncFromPort();

    expect(controller.intentOn).toBe(false);
    await vi.waitFor(() => expect(controller.pending).toBe(false));
    expect(port.isMicrophoneEnabled).toBe(false);
  });

  it("ignores port events raised by its own reconciliation", async () => {
    const { port } = createPort();
    let releaseRecover: (() => void) | undefined;
    const recover = vi.fn(
      () =>
        new Promise<MicrophoneRecoveryResult>((resolve) => {
          releaseRecover = () => resolve("ok");
        }),
    );
    const controller = new MicrophoneController(port, "off", { recover });

    controller.setIntent("on");
    await vi.waitFor(() => expect(releaseRecover).toBeDefined());
    controller.syncFromPort(); // the TrackUnmuted our own publish just raised

    releaseRecover?.();
    await vi.waitFor(() => expect(controller.pending).toBe(false));
    expect(controller.intentOn).toBe(true);
  });

  it("adopts an external mute while health recovery is in flight", async () => {
    const { port } = createPort({ startOn: true });
    let releaseRecover: (() => void) | undefined;
    const recover = vi.fn(
      () => new Promise<MicrophoneRecoveryResult>((resolve) => {
        releaseRecover = () => resolve("cancelled");
      }),
    );
    const controller = new MicrophoneController(port, "on", { recover });

    controller.invalidateHealth();
    await vi.waitFor(() => expect(releaseRecover).toBeDefined());

    await port.setMicrophoneEnabled(false);
    controller.syncFromPort();
    releaseRecover?.();

    await vi.waitFor(() => expect(controller.pending).toBe(false));
    expect(controller.intentOn).toBe(false);
    expect(port.isMicrophoneEnabled).toBe(false);
  });

  it("stops reconciling once disposed", async () => {
    const { port } = createPort();
    const controller = new MicrophoneController(port, "off", { recover: healthy });

    controller.dispose();
    controller.setIntent("on");

    await Promise.resolve();
    expect(port.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  describe("restartCapture", () => {
    /** A port whose microphone track can be restarted, as LiveKit's can. */
    function restartablePort(startOn: boolean) {
      const { port } = createPort({ startOn });
      let release: (() => void) | null = null;
      const restartTrack = vi.fn(
        () => new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      const getTrackPublication = port.getTrackPublication;
      port.getTrackPublication = (source) => {
        const publication = getTrackPublication(source);
        return publication && { ...publication, track: publication.track && { ...publication.track, restartTrack } };
      };
      return { port, restartTrack, release: () => release?.() };
    }

    it("re-acquires the capture of a microphone that is on, without touching intent", async () => {
      const { port, restartTrack, release } = restartablePort(true);
      const controller = new MicrophoneController(port, "on", { recover: healthy });

      const restarted = controller.restartCapture();
      expect(controller.pending).toBe(true);
      release();

      await expect(restarted).resolves.toBe(true);
      await vi.waitFor(() => expect(controller.pending).toBe(false));
      expect(restartTrack).toHaveBeenCalledTimes(1);
      expect(controller.intentOn).toBe(true);
      expect(port.setMicrophoneEnabled).not.toHaveBeenCalled();
    });

    it("leaves a muted microphone alone", async () => {
      const { port, restartTrack } = restartablePort(false);
      const controller = new MicrophoneController(port, "off", { recover: healthy });

      await expect(controller.restartCapture()).resolves.toBe(false);
      expect(restartTrack).not.toHaveBeenCalled();
    });

    it("holds the slot, so a mute during the restart waits for it", async () => {
      const { port, release } = restartablePort(true);
      const controller = new MicrophoneController(port, "on", { recover: healthy });

      const restarted = controller.restartCapture();
      controller.setIntent("off");
      expect(port.setMicrophoneEnabled).not.toHaveBeenCalled();
      await expect(controller.restartCapture()).resolves.toBe(false);

      release();
      await restarted;
      await vi.waitFor(() => expect(port.setMicrophoneEnabled).toHaveBeenCalledWith(false));
      await vi.waitFor(() => expect(controller.pending).toBe(false));
      expect(port.isMicrophoneEnabled).toBe(false);
    });
  });
});

import type { LocalTrack } from "livekit-client";
import type { ScreenShareAsk } from "@/modules/meetings/contract/live-state";
import { MediaOperationQueue } from "./media-operation-queue";

/** How long captured tracks are held while no moderator answers. */
export const SCREEN_SHARE_DECISION_TIMEOUT_MS = 15_000;
/** How long an approval may take to reach this browser as a publish permission. */
export const SCREEN_SHARE_PERMISSION_TIMEOUT_MS = 10_000;
/** How long a refusal stays on screen. */
export const SCREEN_SHARE_DENIED_NOTICE_MS = 3_000;

export type ScreenShareRequestState = "idle" | "pending" | "approved" | "denied";

export type ScreenShareNotice =
  | "unsupported"
  | "start-failed"
  | "capture-failed"
  | "publish-failed"
  | "request-failed"
  | "decision-timed-out"
  | "permission-timed-out";

/** What the controller needs from the browser, the room and the server. */
export interface ScreenShareCapturePort {
  isSharing(): boolean;
  stopSharing(): Promise<void>;
  canCaptureDisplay(): boolean;
  capture(): Promise<LocalTrack[]>;
  publish(tracks: LocalTrack[]): Promise<void>;
  request(): Promise<unknown>;
  withdraw(): Promise<unknown>;
  notify(notice: ScreenShareNotice): void;
  logError(message: string, error: unknown): void;
}

export interface ScreenShareCaptureSnapshot {
  requestState: ScreenShareRequestState;
  isPreparing: boolean;
  hasPrepared: boolean;
  hasPermission: boolean;
}

/** Where this browser's capture stands. Only `held` and `publishing` own tracks. */
type Flow =
  | { kind: "idle" }
  | { kind: "picking" }
  | { kind: "held"; tracks: LocalTrack[] }
  | { kind: "publishing"; tracks: LocalTrack[] };

type Deadline = "decision" | "permission" | "denied-notice";

const IDLE: Flow = { kind: "idle" };

function userCancelledPicker(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

/**
 * One participant's screen capture for one room.
 *
 * The room owns the request and its answer and reports them as an
 * {@link ScreenShareAsk}; this browser owns the captured tracks. Every report
 * and every local step lands in {@link changed}, which brings the two together:
 * a refusal releases the capture, a permission publishes it, a deadline ends
 * the wait, and a request the room holds with no capture behind it is
 * withdrawn. So the outcome does not depend on what arrives first.
 */
export class ScreenShareCapture {
  private readonly listeners = new Set<() => void>();
  private readonly queue = new MediaOperationQueue();
  private flow: Flow = IDLE;
  private active = false;
  private canModerate = false;
  private hasPermission = false;
  private ask: ScreenShareAsk | null = null;
  private askObserved = false;
  /** The newest refusal already shown, or standing when this client arrived. */
  private dismissedDecline = 0;
  /** The request revision this client has taken back; it no longer counts as open. */
  private withdrawnRevision = 0;
  /** Invalidates a browser picker still open when the room goes away. */
  private generation = 0;
  private givingBack = false;
  private removeTrackListeners: Array<() => void> = [];
  private deadline: Deadline | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: ScreenShareCaptureSnapshot;

  constructor(private readonly port: ScreenShareCapturePort) {
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ScreenShareCaptureSnapshot => this.snapshot;

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.changed();
  }

  /** The room went away. Restartable, so a remount resumes the same controller. */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    const held = this.flow.kind === "held";
    this.releaseTracks();
    if (held) this.withdraw();
    this.flow = IDLE;
    this.setDeadline(null);
    this.publish();
  }

  setCanModerate(canModerate: boolean): void {
    if (canModerate === this.canModerate) return;
    this.canModerate = canModerate;
    this.changed();
  }

  setPermission(hasPermission: boolean): void {
    if (hasPermission === this.hasPermission) return;
    this.hasPermission = hasPermission;
    this.changed();
  }

  /** What the room last reported. A report older than one already seen is dropped. */
  setAsk(ask: ScreenShareAsk | null): void {
    if (ask && this.ask && ask.revision < this.ask.revision) return;
    if (ask?.state === "declined" && !this.askObserved) this.dismissedDecline = ask.revision;
    this.askObserved = true;
    this.ask = ask;
    this.changed();
  }

  /**
   * The share button. Queued, so rapid presses settle in order rather than
   * disappearing behind a browser picker that is still open.
   */
  toggle = (): Promise<void> => this.queue.enqueue(() => this.runToggle());

  /** Give up on a request, or on a grant whose share has not started. */
  cancel = (): void => {
    this.releaseTracks();
    this.flow = IDLE;
    this.withdraw();
    this.changed();
  };

  dismissDenied = (): void => {
    this.acknowledgeDecline();
    this.changed();
  };

  /**
   * The published share ended, or the connection did: give the grant back so
   * approval is not sticky. Only one of these is in flight at a time.
   */
  giveBack(): void {
    if (this.canModerate || this.givingBack) return;
    this.givingBack = true;
    this.port
      .withdraw()
      .catch((error: unknown) => this.port.logError("[Meeting] Failed to revoke screen share permission:", error))
      .finally(() => {
        this.givingBack = false;
      });
  }

  disconnected(): void {
    if (this.hasPermission) this.giveBack();
  }

  private get requestState(): ScreenShareRequestState {
    if (this.canModerate) return "idle";
    const ask = this.ask;
    if (ask?.state === "granted") return "approved";
    if (ask?.state === "requested" && ask.revision !== this.withdrawnRevision) return "pending";
    if (ask?.state === "declined" && ask.revision > this.dismissedDecline) return "denied";
    return this.flow.kind === "held" || this.flow.kind === "publishing" ? "pending" : "idle";
  }

  private async runToggle(): Promise<void> {
    if (!this.active) return;
    if (this.port.isSharing()) {
      try {
        await this.port.stopSharing();
      } catch (error) {
        if (userCancelledPicker(error)) return;
        this.port.logError("[Meeting] Screen share error:", error);
      }
      this.releaseTracks();
      this.flow = IDLE;
      this.withdraw();
      this.changed();
      return;
    }
    if (!this.port.canCaptureDisplay()) {
      this.port.notify("unsupported");
      return;
    }
    if (this.canModerate) {
      await this.shareDirectly();
      return;
    }
    if (this.hasPermission) {
      if (this.flow.kind === "held") {
        await this.publishHeld();
        return;
      }
      this.acknowledgeDecline();
      await this.shareDirectly();
      this.changed();
      return;
    }
    const state = this.requestState;
    if (this.flow.kind !== "idle" || state === "pending" || state === "approved") return;
    await this.pickAndRequest();
  }

  /** Allowed to share already: nothing to ask, nothing to hold. */
  private async shareDirectly(): Promise<void> {
    const generation = this.generation;
    let tracks: LocalTrack[] = [];
    try {
      tracks = await this.port.capture();
      if (generation !== this.generation) {
        stopTracks(tracks);
        return;
      }
      await this.port.publish(tracks);
    } catch (error) {
      stopTracks(tracks);
      if (userCancelledPicker(error)) return;
      this.port.logError("[Meeting] Screen share error:", error);
      this.port.notify("start-failed");
    }
  }

  private async pickAndRequest(): Promise<void> {
    this.acknowledgeDecline();
    this.flow = { kind: "picking" };
    this.changed();
    const generation = this.generation;
    try {
      const tracks = await this.port.capture();
      if (generation !== this.generation) {
        stopTracks(tracks);
        return;
      }
      if (tracks.length === 0) return;
      this.hold(tracks);
      this.changed();
      await this.sendRequest(tracks);
    } catch (error) {
      if (userCancelledPicker(error)) return;
      this.port.logError("[Meeting] Screen share capture error:", error);
      this.port.notify("capture-failed");
    } finally {
      if (this.flow.kind === "picking") this.flow = IDLE;
      this.changed();
    }
  }

  private async sendRequest(tracks: LocalTrack[]): Promise<void> {
    try {
      await this.port.request();
    } catch (error) {
      this.port.logError("[ScreenShare] Request failed:", error);
      if (this.flow.kind === "held" && this.flow.tracks === tracks) {
        this.releaseTracks();
        this.flow = IDLE;
        this.port.notify("request-failed");
      }
    }
  }

  private hold(tracks: LocalTrack[]): void {
    this.flow = { kind: "held", tracks };
    for (const track of tracks) {
      const mediaTrack = track.mediaStreamTrack;
      mediaTrack.addEventListener("ended", this.cancel, { once: true });
      this.removeTrackListeners.push(() => mediaTrack.removeEventListener("ended", this.cancel));
    }
  }

  private clearTrackListeners(): void {
    for (const remove of this.removeTrackListeners) remove();
    this.removeTrackListeners = [];
  }

  private releaseTracks(): void {
    this.clearTrackListeners();
    if (this.flow.kind === "held" || this.flow.kind === "publishing") stopTracks(this.flow.tracks);
  }

  private async publishHeld(): Promise<void> {
    if (this.flow.kind !== "held") return;
    const flow: Flow = { kind: "publishing", tracks: this.flow.tracks };
    this.flow = flow;
    try {
      await this.port.publish(flow.tracks);
      // The grant stays: it is what lets this participant keep sharing, until
      // they stop or a moderator takes it back.
      if (this.flow === flow) {
        this.clearTrackListeners();
        this.flow = IDLE;
      }
    } catch (error) {
      if (this.flow === flow) {
        this.releaseTracks();
        this.flow = IDLE;
        this.withdraw();
        this.port.logError("[Meeting] Failed to publish prepared screen share:", error);
        this.port.notify("publish-failed");
      }
    }
    this.changed();
  }

  private withdraw(): void {
    this.acknowledgeDecline();
    if (this.canModerate) return;
    if (this.ask?.state === "requested") this.withdrawnRevision = this.ask.revision;
    this.port.withdraw().catch((error: unknown) => {
      this.port.logError("[ScreenShare] Cancelling failed:", error);
    });
  }

  private acknowledgeDecline(): void {
    if (this.ask?.state === "declined") this.dismissedDecline = this.ask.revision;
  }

  /** Bring the capture and what the room reports together, then publish. */
  private changed(): void {
    if (this.active) this.converge();
    this.publish();
  }

  private converge(): void {
    if (this.requestState === "denied" && this.flow.kind === "held") {
      this.releaseTracks();
      this.flow = IDLE;
    }

    // The room holds a request this browser has nothing behind: it survived a
    // remount, or a cancel overtook its own request on the way to the server.
    const ask = this.ask;
    if (
      ask?.state === "requested" &&
      ask.revision !== this.withdrawnRevision &&
      this.flow.kind === "idle" &&
      !this.hasPermission &&
      !this.canModerate
    ) {
      this.withdraw();
    }

    if (this.flow.kind === "held" && this.hasPermission) void this.publishHeld();

    const state = this.requestState;
    const waiting = this.flow.kind === "held" && !this.hasPermission;
    this.setDeadline(
      state === "denied"
        ? "denied-notice"
        : waiting && state === "pending"
          ? "decision"
          : waiting && state === "approved"
            ? "permission"
            : null,
    );
  }

  private setDeadline(deadline: Deadline | null): void {
    if (deadline === this.deadline) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = deadline;
    if (!deadline) return;
    const delays: Record<Deadline, number> = {
      decision: SCREEN_SHARE_DECISION_TIMEOUT_MS,
      permission: SCREEN_SHARE_PERMISSION_TIMEOUT_MS,
      "denied-notice": SCREEN_SHARE_DENIED_NOTICE_MS,
    };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deadline = null;
      this.deadlinePassed(deadline);
    }, delays[deadline]);
  }

  private deadlinePassed(deadline: Deadline): void {
    if (deadline === "denied-notice") {
      this.dismissDenied();
      return;
    }
    if (deadline === "permission") {
      this.port.logError("[Meeting] Screen share permission update timed out", undefined);
    }
    this.cancel();
    this.port.notify(deadline === "decision" ? "decision-timed-out" : "permission-timed-out");
  }

  private buildSnapshot(): ScreenShareCaptureSnapshot {
    return {
      requestState: this.requestState,
      isPreparing: this.flow.kind === "picking",
      hasPrepared: this.flow.kind === "held" || this.flow.kind === "publishing",
      hasPermission: this.hasPermission,
    };
  }

  private publish(): void {
    const next = this.buildSnapshot();
    const previous = this.snapshot;
    if (
      next.requestState === previous.requestState &&
      next.isPreparing === previous.isPreparing &&
      next.hasPrepared === previous.hasPrepared &&
      next.hasPermission === previous.hasPermission
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function stopTracks(tracks: LocalTrack[]): void {
  for (const track of tracks) track.stop();
}

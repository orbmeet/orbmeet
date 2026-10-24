import {
  getMicrophoneTrack,
  recoverLocalMicrophoneAfterUnmute,
  type MicrophoneRecoveryResult,
  type MicrophoneRecoverySnapshot,
  type RecoverableMicrophoneParticipant,
} from "@/modules/meetings/client/microphone-recovery";

/**
 * Owns the local microphone as *intent* reconciled against *observed* state.
 *
 * Every microphone bug this replaces came from the same shape: a call site
 * mutating the track and then inferring what the user wanted from whatever it
 * could observe at that instant. Observation cannot distinguish "the user
 * muted" from "recovery muted, mid-repair", so guards cancelled their own work
 * and clicks arriving during an in-flight operation were dropped.
 *
 * Here the user's intent is the only authority. `setIntent` never performs I/O;
 * it records what the user wants and wakes a serialized reconcile loop that
 * drives the track toward it. An intent change during an in-flight operation is
 * picked up on the next iteration, so a click is never lost and intermediate
 * states are coalesced rather than replayed against the SFU.
 */

export type MicrophoneIntent = "on" | "off";

/** Which reconciliation step failed, for message selection by the caller. */
export type MicrophoneFailure = "enable" | "disable" | "heal";

export type MicrophoneControllerPort = RecoverableMicrophoneParticipant;

export interface MicrophoneControllerOptions {
  /** Fires whenever `intentOn` or `pending` changes, to drive a re-render. */
  onStateChange?: () => void;
  onRecoveryAttempt?: (snapshot: MicrophoneRecoverySnapshot) => void;
  onRecoveryResult?: (result: MicrophoneRecoveryResult) => void;
  onFailure?: (failure: MicrophoneFailure, error: unknown) => void;
  /** Seam for tests; defaults to the real repair ladder. */
  recover?: typeof recoverLocalMicrophoneAfterUnmute;
}

export class MicrophoneController {
  private intent: MicrophoneIntent;
  private generation = 0;
  /**
   * The generation whose "on" state has been health-checked. Starts satisfied:
   * the initial publish is verified by the join path, so a freshly constructed
   * controller must not repair a microphone nobody has touched yet.
   */
  private verifiedGeneration = 0;
  private loop: Promise<void> | null = null;
  private disposed = false;
  /** The next track event expected from a mutation owned by this controller. */
  private expectedPortState: MicrophoneIntent | null = null;

  constructor(
    private readonly port: MicrophoneControllerPort,
    initialIntent: MicrophoneIntent,
    private readonly options: MicrophoneControllerOptions = {},
  ) {
    this.intent = initialIntent;
  }

  get intentOn(): boolean {
    return this.intent === "on";
  }

  /** True while the loop is driving the track toward intent. */
  get pending(): boolean {
    return this.loop !== null;
  }

  setIntent(next: MicrophoneIntent): void {
    if (this.disposed || next === this.intent) return;
    this.intent = next;
    this.generation += 1;
    this.options.onStateChange?.();
    this.kick();
  }

  toggle(): void {
    this.setIntent(this.intent === "on" ? "off" : "on");
  }

  /**
   * Marks the current "on" state as unproven — a device error, a route change,
   * anything that means the published track may no longer be carrying audio.
   * Reconciliation re-runs the repair ladder without disturbing intent.
   */
  invalidateHealth(): void {
    if (this.disposed || this.intent !== "on") return;
    this.verifiedGeneration = -1;
    this.kick();
  }

  /**
   * Adopts an externally applied mute/unmute as the user's intent — teardown
   * (`stopAllLocalTracks`), a server-side mute, anything that changes the track
   * without going through this controller. Adopting rather than reverting is
   * what keeps reconciliation from fighting the rest of the app. Only the
   * exact event expected from our own current mutation is ignored; an external
   * mute while recovery is waiting is still authoritative.
   */
  syncFromPort(): void {
    if (this.disposed) return;
    const actual: MicrophoneIntent = this.port.isMicrophoneEnabled ? "on" : "off";
    if (actual === this.expectedPortState) {
      this.expectedPortState = null;
      return;
    }
    if (actual === this.intent) return;
    this.intent = actual;
    this.generation += 1;
    this.verifiedGeneration = this.generation;
    this.options.onStateChange?.();
  }

  /**
   * Re-acquires the capture behind a microphone that is on — for a source the
   * system stopped (an iPadOS call takes the audio session and WebKit never
   * gives it back). Intent and the published track's mute state are untouched:
   * the user still wants the microphone, it just needs a new device stream.
   *
   * Runs in the reconcile slot, so it cannot interleave with a mute or a
   * repair. Resolves false when there is nothing to restart right now — the
   * microphone is off, or the loop is busy — and rejects when the browser
   * refuses the new capture.
   */
  restartCapture(): Promise<boolean> {
    if (this.disposed || this.intent !== "on" || this.loop) return Promise.resolve(false);
    const track = getMicrophoneTrack(this.port);
    const restartTrack = track?.restartTrack;
    if (!restartTrack) return Promise.resolve(false);
    const restarted = restartTrack.call(track).then(() => true);
    this.occupy(restarted.then(() => undefined, () => undefined));
    return restarted;
  }

  dispose(): void {
    this.disposed = true;
  }

  private needsWork(): boolean {
    const desiredOn = this.intent === "on";
    if (desiredOn !== this.port.isMicrophoneEnabled) return true;
    return desiredOn && this.verifiedGeneration !== this.generation;
  }

  private kick(): void {
    if (this.disposed || this.loop || !this.needsWork()) return;
    this.occupy(this.reconcile());
  }

  /** Holds the single slot every track mutation runs in, then hands it on. */
  private occupy(work: Promise<void>): void {
    this.loop = work.finally(() => {
      this.loop = null;
      // Re-check after clearing the handle: an intent change that landed
      // between the loop's last check and this point would otherwise be
      // dropped, because `kick` refuses to start a second loop.
      if (!this.disposed && this.needsWork()) this.kick();
      else this.options.onStateChange?.();
    });
    this.options.onStateChange?.();
  }

  private async reconcile(): Promise<void> {
    for (;;) {
      if (this.disposed) return;

      const desiredOn = this.intent === "on";
      const actualOn = this.port.isMicrophoneEnabled;

      if (desiredOn !== actualOn) {
        try {
          await this.setPortEnabled(desiredOn);
        } catch (error) {
          this.options.onFailure?.(desiredOn ? "enable" : "disable", error);
          // An unmute that cannot be applied is not a state to retry forever:
          // fall back to muted and let the loop settle there.
          if (desiredOn) this.forceOff();
          else return;
        }
        continue;
      }

      if (!desiredOn) return;
      if (this.verifiedGeneration === this.generation) return;

      const generation = this.generation;
      const recover = this.options.recover ?? recoverLocalMicrophoneAfterUnmute;
      try {
        const result = await recover(this.port, {
          // Intent is the only cancellation signal. The repair ladder toggles
          // the track itself, so a guard reading live state would cancel on its
          // own work — the defect this whole module exists to make impossible.
          shouldContinue: () => !this.disposed && this.generation === generation,
          onRecoveryAttempt: (snapshot) => this.options.onRecoveryAttempt?.(snapshot),
          setMicrophoneEnabled: (enabled) => this.setPortEnabled(enabled),
        });
        this.options.onRecoveryResult?.(result);
        if (this.generation === generation) this.verifiedGeneration = generation;
      } catch (error) {
        this.options.onFailure?.("heal", error);
        if (this.generation === generation) this.forceOff();
      }
    }
  }

  /**
   * Drops to muted as a new intent, so the loop reconciles to it and any
   * observer sees the microphone the user is actually left with.
   */
  private forceOff(): void {
    this.intent = "off";
    this.generation += 1;
    this.verifiedGeneration = this.generation;
    this.options.onStateChange?.();
  }

  private async setPortEnabled(enabled: boolean): Promise<unknown> {
    const expected: MicrophoneIntent = enabled ? "on" : "off";
    this.expectedPortState = expected;
    try {
      return await this.port.setMicrophoneEnabled(enabled);
    } finally {
      // LiveKit normally emits before its promise resolves. Keep the marker
      // through one microtask for implementations that publish immediately
      // after resolution, then discard it so it cannot mask a later external
      // moderation event.
      queueMicrotask(() => {
        if (this.expectedPortState === expected) this.expectedPortState = null;
      });
    }
  }
}

/**
 * Keeps meeting media playable, treating "can the browser play it" as owned
 * state rather than a banner that reacts to an SDK event.
 *
 * Autoplay policy rejects un-gestured `play()`, and on iOS/iPadOS a freshly
 * created AudioContext starts suspended — so a listener who joins muted has
 * nothing granting playback and hears silence until they find a button.
 * Safari in Low Power Mode refuses remote video the same way. The
 * only reliable remedy is to retry inside a real user gesture, and the meeting
 * UI is full of gestures that are not that button: tapping a tile, opening
 * chat, hitting a control. This arms the *next* gesture of any kind, so the
 * common case resolves itself and the explicit affordance is a fallback.
 */

export type PlaybackUnlockTrigger = "auto" | "gesture" | "explicit";

export interface PlaybackUnlockPort {
  canPlay: () => boolean;
  /**
   * Must synchronously issue the underlying `play()` calls to stay inside the
   * gesture. Settling says nothing about the outcome — LiveKit swallows a
   * refused video — so `canPlay` is asked afterwards.
   */
  play: () => Promise<void>;
  /** Registers a one-shot user-gesture listener and returns a disposer. */
  onNextUserGesture: (handler: () => void) => () => void;
}

export interface PlaybackUnlockOptions {
  onStateChange?: () => void;
  onDiagnostic?: (
    event: "unlocked" | "blocked" | "failed",
    data: { trigger: PlaybackUnlockTrigger; attempts: number; error?: unknown },
  ) => void;
}

export class PlaybackUnlock {
  private disposed = false;
  private disarmGesture: (() => void) | null = null;
  private attempts = 0;
  private inFlight = false;

  constructor(
    private readonly port: PlaybackUnlockPort,
    private readonly options: PlaybackUnlockOptions = {},
  ) {}

  get blocked(): boolean {
    return !this.port.canPlay();
  }

  /**
   * Attempts playback without a gesture — which succeeds wherever the page is
   * already unlocked — and otherwise arms the next gesture.
   */
  start(): void {
    void this.attempt("auto");
  }

  /** The explicit affordance: already inside a click, so it can retry directly. */
  unlockFromUserGesture(): void {
    void this.attempt("explicit");
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  private async attempt(trigger: PlaybackUnlockTrigger): Promise<void> {
    if (this.disposed || this.inFlight) return;
    if (this.port.canPlay()) {
      this.disarm();
      return;
    }

    this.inFlight = true;
    this.attempts += 1;
    const attempts = this.attempts;
    let error: unknown;
    try {
      await this.port.play();
    } catch (caught) {
      error = caught;
    } finally {
      this.inFlight = false;
    }
    if (this.disposed) return;
    if (this.port.canPlay()) {
      this.disarm();
      this.options.onDiagnostic?.("unlocked", { trigger, attempts });
    } else {
      // Expected on the auto attempt: no gesture, so the browser says no.
      this.options.onDiagnostic?.(trigger === "auto" ? "blocked" : "failed", { trigger, attempts, error });
      this.arm();
    }
    this.options.onStateChange?.();
  }

  private arm(): void {
    if (this.disposed || this.disarmGesture) return;
    this.disarmGesture = this.port.onNextUserGesture(() => {
      this.disarmGesture = null;
      void this.attempt("gesture");
    });
  }

  private disarm(): void {
    this.disarmGesture?.();
    this.disarmGesture = null;
  }
}

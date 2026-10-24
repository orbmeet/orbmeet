/**
 * Notices a microphone the system has stopped while the user still wants it
 * on, and brings it back.
 *
 * On iPadOS an incoming call (a WhatsApp call through CallKit, a FaceTime ring)
 * takes the audio session. WebKit suspends capture and mutes the track; LiveKit
 * then pauses its upstream. When the call ends WebKit is meant to resume — but
 * it does not reliably (a second suspend while already suspended records that
 * capture may not resume; fixed on WebKit main as 317299@main, in no shipped
 * Safari as of 27.0.1), and LiveKit's own re-acquire on returning to the
 * foreground is skipped on iPad, which it detects as a Mac. Nothing reports
 * the loss: the mute button still says on, and nobody hears the speaker.
 *
 * Three observations mean the microphone is not reaching the meeting:
 * - `session`: the page's audio session says it is interrupted;
 * - `device`: the capture track is muted by its source, or LiveKit has paused
 *   the upstream because of it;
 * - `silent`: the sender has sent no packets across two samples. Opus DTX
 *   still sends a frame every 400 ms through silence, so a quiet speaker is
 *   never mistaken for this; it catches a capture that stalls without saying so.
 *
 * Recovery is a restart of the capture (a new `getUserMedia`), tried with a
 * backoff while the page is visible and the session is not interrupted, at
 * once when either of those changes, on the next user gesture anywhere, and
 * from the explicit affordance. The state clears only once packets are seen
 * flowing again — a restart that returns a track the system still holds muted
 * is not a recovery.
 */

export type MicrophoneInterruptionCause = "session" | "device" | "silent";
export type MicrophoneResumeTrigger = "auto" | "gesture" | "explicit";
export type AudioSessionState = "active" | "inactive" | "interrupted";

interface MicrophoneCaptureObservation {
  /** The capture track's `muted`, or null with no published track. */
  trackMuted: boolean | null;
  /** LiveKit stopped sending because the track's source went quiet. */
  upstreamPaused: boolean;
  /** `navigator.audioSession.state`, or null where the engine has none. */
  audioSession: AudioSessionState | null;
}

export interface MicrophoneInterruptionPort {
  /** The user wants the microphone on. */
  intentOn: () => boolean;
  /**
   * Nothing meaningful can be measured right now: the microphone is mid-change
   * (a toggle, a repair, a restart), or the connection is not up — a link
   * that is reconnecting sends no packets either, and that is not the
   * microphone's doing.
   */
  busy: () => boolean;
  observe: () => MicrophoneCaptureObservation;
  /** Packets the microphone's sender has sent so far, or null if unknown. */
  packetsSent: () => Promise<number | null>;
  pageVisible: () => boolean;
  /** Re-acquires capture; false when there was nothing to restart now. */
  restart: () => Promise<boolean>;
  /** Registers a one-shot user-gesture listener and returns a disposer. */
  onNextUserGesture: (handler: () => void) => () => void;
}

export type MicrophoneInterruptionDiagnostic =
  | {
      event: "interrupted";
      cause: MicrophoneInterruptionCause;
      observation: MicrophoneCaptureObservation;
    }
  | {
      event: "resume_failed";
      trigger: MicrophoneResumeTrigger;
      attempts: number;
      error: unknown;
    }
  | {
      event: "resumed";
      /** `system`: it came back without a restart; `restart`: ours brought it back. */
      via: "system" | "restart" | "muted";
      cause: MicrophoneInterruptionCause;
      trigger: MicrophoneResumeTrigger | null;
      attempts: number;
      interruptedForMs: number;
    };

export interface MicrophoneInterruptionOptions {
  onStateChange?: () => void;
  onDiagnostic?: (diagnostic: MicrophoneInterruptionDiagnostic) => void;
  now?: () => number;
}

/** How often the sender is sampled, and the timers re-check what they observe. */
export const MICROPHONE_SAMPLE_INTERVAL_MS = 5_000;
/** Consecutive samples without a packet before the microphone counts as silent. */
const SILENT_SAMPLES = 2;
/** After a restart, how soon to look for packets again. */
const VERIFY_AFTER_RESTART_MS = 2_000;
/** The least time between restarts a gesture may start: every stroke on the board is one. */
const GESTURE_RESTART_SPACING_MS = 3_000;
/** Waits between automatic restarts; the last repeats. */
const MICROPHONE_RESUME_DELAYS_MS = [1_000, 3_000, 5_000, 10_000, 20_000, 30_000] as const;

/** What the latest samples say about packets leaving. */
type Flow = "moving" | "stalled" | "unmeasured" | "pending";

export class MicrophoneInterruption {
  private disposed = false;
  private cause: MicrophoneInterruptionCause | null = null;
  private interruptedAt = 0;
  private attempts = 0;
  private lastTrigger: MicrophoneResumeTrigger | null = null;
  private inFlight = false;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  /** {@link restartAllowed} as last evaluated: a change to it is what restarts at once. */
  private wasRestartAllowed = true;

  private lastPackets: number | null = null;
  private silentSamples = 0;
  private flow: Flow = "pending";
  private sampling = false;

  private sampleTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disarmGesture: (() => void) | null = null;

  constructor(
    private readonly port: MicrophoneInterruptionPort,
    private readonly options: MicrophoneInterruptionOptions = {},
  ) {}

  /** True while the microphone is meant to be on and is not reaching the meeting. */
  get interrupted(): boolean {
    return this.cause !== null;
  }

  /** Why, while interrupted. */
  get interruptionCause(): MicrophoneInterruptionCause | null {
    return this.cause;
  }

  /** Begins sampling the sender. */
  start(): void {
    if (this.disposed || this.sampleTimer !== null) return;
    this.scheduleSample(MICROPHONE_SAMPLE_INTERVAL_MS);
    void this.sample();
  }

  /**
   * Something that bears on the microphone changed — its track, the audio
   * session, the page's visibility, the user's intent. Re-evaluates now, and
   * restarts at once when the change is the one recovery was waiting for.
   */
  check(): void {
    if (this.disposed) return;
    const wasAllowed = this.wasRestartAllowed;
    this.evaluate();
    // Any other change (a reconnect, a session that turns inactive, a mute
    // toggled off and on) leaves recovery to its backoff, so a capture that
    // keeps coming back muted is re-acquired at the backoff's pace.
    if (this.cause && !wasAllowed && this.mayRestartUnprompted()) {
      this.clearRetry();
      void this.attempt("auto");
    }
  }

  /** The explicit affordance: already inside a click, so it restarts directly. */
  resumeFromUserGesture(): void {
    void this.attempt("explicit");
  }

  dispose(): void {
    this.disposed = true;
    if (this.sampleTimer !== null) clearTimeout(this.sampleTimer);
    this.sampleTimer = null;
    this.clearRetry();
    this.disarm();
  }

  // ── Observation ─────────────────────────────────────────────────────────

  private scheduleSample(delayMs: number): void {
    if (this.disposed) return;
    if (this.sampleTimer !== null) clearTimeout(this.sampleTimer);
    this.sampleTimer = setTimeout(() => {
      this.sampleTimer = null;
      this.scheduleSample(MICROPHONE_SAMPLE_INTERVAL_MS);
      void this.sample();
    }, delayMs);
  }

  private async sample(): Promise<void> {
    if (this.disposed || this.sampling) return;
    if (!this.port.intentOn() || this.port.busy()) {
      // A toggle or repair replaces what was being measured: start over.
      this.resetFlow();
      this.evaluate();
      return;
    }
    this.sampling = true;
    try {
      const packets = await this.port.packetsSent().catch(() => null);
      if (this.disposed) return;
      if (packets === null) {
        this.lastPackets = null;
        this.silentSamples = 0;
        this.flow = "unmeasured";
      } else if (this.lastPackets === null || packets < this.lastPackets) {
        // A first reading, or a new sender: a baseline, not yet a verdict.
        this.lastPackets = packets;
      } else if (packets > this.lastPackets) {
        this.lastPackets = packets;
        this.silentSamples = 0;
        this.flow = "moving";
      } else {
        this.silentSamples += 1;
        this.flow = "stalled";
      }
    } finally {
      this.sampling = false;
    }
    this.evaluate();
  }

  private resetFlow(): void {
    this.lastPackets = null;
    this.silentSamples = 0;
    this.flow = "pending";
  }

  private observedCause(): MicrophoneInterruptionCause | null {
    const observation = this.port.observe();
    if (observation.audioSession === "interrupted") return "session";
    if (observation.trackMuted === true || observation.upstreamPaused) return "device";
    if (this.silentSamples >= SILENT_SAMPLES) return "silent";
    return null;
  }

  private evaluate(): void {
    if (this.disposed) return;
    this.wasRestartAllowed = this.restartAllowed();
    if (!this.port.intentOn()) {
      // Muting answers the problem as far as the user is concerned.
      if (this.cause) this.end("muted");
      return;
    }
    // Mid-change, what is observed is the change, not the microphone.
    if (this.port.busy()) return;

    // The cause stays what began the interruption: a call that ends leaves the
    // capture muted, and that is still the call's doing.
    const observed = this.observedCause();
    if (observed) {
      if (!this.cause) this.begin(observed);
      return;
    }
    if (this.cause && (this.flow === "moving" || this.flow === "unmeasured")) {
      this.end(this.attempts > 0 && this.lastTrigger !== null ? "restart" : "system");
    }
  }

  // ── Recovery ────────────────────────────────────────────────────────────

  private begin(cause: MicrophoneInterruptionCause): void {
    this.cause = cause;
    this.interruptedAt = this.now();
    this.attempts = 0;
    this.lastTrigger = null;
    this.options.onDiagnostic?.({ event: "interrupted", cause, observation: this.port.observe() });
    this.arm();
    this.scheduleRetry();
    this.options.onStateChange?.();
  }

  private end(via: "system" | "restart" | "muted"): void {
    const cause = this.cause;
    if (!cause) return;
    this.options.onDiagnostic?.({
      event: "resumed",
      via,
      cause,
      trigger: via === "restart" ? this.lastTrigger : null,
      attempts: this.attempts,
      interruptedForMs: Math.round(this.now() - this.interruptedAt),
    });
    this.cause = null;
    this.attempts = 0;
    this.lastTrigger = null;
    this.lastAttemptAt = Number.NEGATIVE_INFINITY;
    this.clearRetry();
    this.disarm();
    this.options.onStateChange?.();
  }

  /**
   * An unprompted restart is pointless while the system holds the audio (it
   * hands back a muted track or refuses), and a hidden page may not capture.
   */
  private mayRestartUnprompted(): boolean {
    if (!this.restartAllowed()) return false;
    // The system may have let go by itself; the next sample will tell, and a
    // restart then would only cut the sound it just gave back.
    return this.observedCause() !== null;
  }

  /** What unprompted recovery waits for: a page that may capture, and audio the system has let go of. */
  private restartAllowed(): boolean {
    return this.port.pageVisible() && this.port.observe().audioSession !== "interrupted";
  }

  private scheduleRetry(): void {
    this.clearRetry();
    if (!this.cause) return;
    const delays = MICROPHONE_RESUME_DELAYS_MS;
    const delay = delays[Math.min(this.attempts, delays.length - 1)];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.cause) return;
      if (this.mayRestartUnprompted()) void this.attempt("auto");
      else this.scheduleRetry();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async attempt(trigger: MicrophoneResumeTrigger): Promise<void> {
    if (this.disposed || this.inFlight || !this.cause) return;
    this.inFlight = true;
    this.attempts += 1;
    this.lastAttemptAt = this.now();
    const attempts = this.attempts;
    try {
      const restarted = await this.port.restart();
      if (this.disposed) return;
      if (restarted) {
        this.lastTrigger = trigger;
        // The new capture has to prove itself: look for packets shortly.
        this.resetFlow();
        void this.sample();
        this.scheduleSample(VERIFY_AFTER_RESTART_MS);
      }
    } catch (error) {
      if (this.disposed) return;
      this.options.onDiagnostic?.({ event: "resume_failed", trigger, attempts, error });
    } finally {
      this.inFlight = false;
    }
    if (this.disposed || !this.cause) return;
    this.arm();
    this.scheduleRetry();
  }

  private arm(): void {
    if (this.disposed || this.disarmGesture) return;
    this.disarmGesture = this.port.onNextUserGesture(() => {
      this.disarmGesture = null;
      if (this.now() - this.lastAttemptAt < GESTURE_RESTART_SPACING_MS) {
        this.arm();
        return;
      }
      void this.attempt("gesture");
    });
  }

  private disarm(): void {
    this.disarmGesture?.();
    this.disarmGesture = null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

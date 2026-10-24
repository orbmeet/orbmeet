import { randomUUID } from "node:crypto";
import { childController, sleep } from "../abort.js";
import {
  recordTranscriptionConnectionStatus,
  removeTranscriptionConnectionStatus,
} from "../outbox/transcription-health.js";
import type { AudioSource } from "./audio-source.js";
import { DeepgramAttempt, type OpenDeepgramSocket } from "./deepgram-attempt.js";
import type { TranscriptEvent } from "./transcript-assembler.js";
import { logWarn } from "../log.js";

const RECONNECT_DELAYS_MS = [0, 250, 1_000, 3_000, 8_000, 15_000, 30_000] as const;
/**
 * How long a connection must stay up before its failure counts as a fresh
 * start. Opening alone proves nothing: a connection Deepgram accepts and then
 * drops at once would otherwise reconnect with no backoff, forever, while
 * health reads "connected".
 */
const STABLE_CONNECTION_MS = 30_000;
/**
 * How long a muted microphone's utterance waits for Deepgram's answer to
 * Finalize. Deepgram does not promise one, so the wait is bounded.
 */
const FINALIZE_GRACE_MS = 2_000;

export interface TranscriptionSupervisorOptions {
  source: AudioSource;
  open: OpenDeepgramSocket;
  language: string;
  /** Whether the meeting transcribes at the start; `setEnabled` follows it after. */
  enabled?: boolean;
  onEvent: (event: TranscriptEvent) => void;
  id?: string;
  now?: () => number;
}

/**
 * Keeps one Deepgram connection transcribing the job's audio source.
 *
 * It is the single owner of the job's transcription work. Every attempt runs
 * in a child of the supervisor's scope, so `close()` ends a retry wait, an
 * opening socket or a live connection alike, at once. A language change stops
 * the current attempt gracefully and the loop opens the next in the new
 * language; nothing else is queued behind it.
 *
 * While the meeting has transcription off it holds no connection at all: the
 * current attempt stops, the source drops the audio, and the loop waits to be
 * enabled before opening the next.
 */
export class TranscriptionSupervisor {
  private readonly scope = new AbortController();
  private readonly id: string;
  private language: string;
  private current: { attempt: DeepgramAttempt; controller: AbortController } | null = null;
  private loop: Promise<void> | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled: boolean;
  private wakeEnabled: (() => void) | null = null;

  constructor(private readonly options: TranscriptionSupervisorOptions) {
    this.id = options.id ?? randomUUID();
    this.language = options.language;
    this.enabled = options.enabled ?? true;
    options.source.setAccepting(this.enabled);
  }

  start(): void {
    if (this.scope.signal.aborted) return;
    this.loop ??= this.run();
  }

  setLanguage(language: string): void {
    if (language === this.language || this.scope.signal.aborted) return;
    this.language = language;
    this.current?.controller.abort(new Error("caption language changed"));
  }

  /** The meeting turned transcription on or off. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled || this.scope.signal.aborted) return;
    this.enabled = enabled;
    this.options.source.setAccepting(enabled);
    if (enabled) {
      this.wakeEnabled?.();
      return;
    }
    this.cancelFinalize();
    this.current?.controller.abort(new Error("transcription turned off"));
  }

  /** The microphone went quiet on purpose: close the utterance now rather than at the next pause. */
  finalize(): void {
    if (this.scope.signal.aborted) return;
    this.current?.attempt.finalize();
    this.cancelFinalize();
    this.finalizeTimer = setTimeout(() => {
      this.finalizeTimer = null;
      this.options.onEvent({ kind: "interrupt" });
    }, FINALIZE_GRACE_MS);
  }

  /** The microphone is live again: what follows is a new utterance, not a late answer to Finalize. */
  cancelFinalize(): void {
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = null;
  }

  async close(): Promise<void> {
    this.cancelFinalize();
    this.scope.abort(new Error("transcription stopping"));
    try {
      await this.loop;
    } finally {
      removeTranscriptionConnectionStatus(this.id);
    }
  }

  private async run(): Promise<void> {
    const now = this.options.now ?? Date.now;
    let failures = 0;
    while (!this.scope.signal.aborted) {
      if (!this.enabled) {
        removeTranscriptionConnectionStatus(this.id);
        await this.untilEnabled();
        continue;
      }
      const controller = childController(this.scope.signal);
      let openedAt: number | null = null;
      const attempt = new DeepgramAttempt({
        open: this.options.open,
        language: this.language,
        source: this.options.source,
        signal: controller.signal,
        onEvent: this.options.onEvent,
        onOpen: () => {
          openedAt = now();
          recordTranscriptionConnectionStatus(this.id, "connected");
        },
      });
      this.current = { attempt, controller };
      recordTranscriptionConnectionStatus(this.id, "connecting");
      try {
        await attempt.run();
        // Stopped on purpose (a language change); nothing failed.
        failures = 0;
      } catch (error) {
        // Turned off mid-attempt: the stop was ours, not a failure to retry.
        if (!this.enabled) continue;
        if (openedAt !== null && now() - openedAt >= STABLE_CONNECTION_MS) failures = 0;
        failures += 1;
        const retryDelay = RECONNECT_DELAYS_MS[Math.min(failures - 1, RECONNECT_DELAYS_MS.length - 1)];
        logWarn("Deepgram connection attempt failed", { attempt: failures, retryDelay, error });
        // While waiting to retry, the last recorded phase is the truthful one.
        if (failures >= RECONNECT_DELAYS_MS.length) {
          recordTranscriptionConnectionStatus(this.id, "failed", error);
        }
        await sleep(retryDelay, this.scope.signal);
      } finally {
        this.current = null;
        controller.abort();
      }
    }
  }

  /** Resolves once enabled, or when the supervisor closes. */
  private untilEnabled(): Promise<void> {
    if (this.enabled || this.scope.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.wakeEnabled = null;
        this.scope.signal.removeEventListener("abort", done);
        resolve();
      };
      this.wakeEnabled = done;
      this.scope.signal.addEventListener("abort", done, { once: true });
    });
  }
}

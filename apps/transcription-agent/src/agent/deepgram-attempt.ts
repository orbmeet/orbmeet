import { abortable, childController, sleep, withDeadline } from "../abort.js";
import { AudioTimeline } from "./audio-timeline.js";
import { containsLikelySpeech, type AudioSource } from "./audio-source.js";
import type { TranscriptEvent } from "./transcript-assembler.js";
import { logInfo } from "../log.js";

const CONNECTION_OPEN_TIMEOUT_MS = 12_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
const KEEP_ALIVE_INTERVAL_MS = 5_000;
const INBOUND_LIVENESS_TIMEOUT_MS = 20_000;
const LIVENESS_CHECK_INTERVAL_MS = 1_000;
/**
 * Deepgram accepts catch-up audio at up to 1.25x realtime. 1.2x drains a
 * reconnect backlog while staying under that cap.
 */
const CATCH_UP_RATE = 1.2;

/** The Deepgram messages the agent reads; everything else is ignored. */
export type DeepgramMessage =
  | {
      type: "Results";
      start: number;
      duration: number;
      is_final?: boolean;
      speech_final?: boolean;
      from_finalize?: boolean;
      channel: { alternatives: Array<{ transcript: string }> };
    }
  | { type: "UtteranceEnd" }
  | { type: string };

/** One Deepgram listen socket, as the agent uses it. */
export interface DeepgramSocket {
  onMessage(handler: (message: DeepgramMessage) => void): void;
  /** Called once, whoever closes the socket, and at once if it is already closed. */
  onClose(handler: () => void): void;
  waitForOpen(): Promise<void>;
  sendAudio(samples: Int16Array): void;
  keepAlive(): void;
  finalize(): void;
  closeStream(): void;
  close(): void;
}

export type OpenDeepgramSocket = (language: string) => Promise<DeepgramSocket>;

export interface DeepgramAttemptOptions {
  open: OpenDeepgramSocket;
  language: string;
  source: AudioSource;
  /** Aborting stops the attempt gracefully: Deepgram finishes what it was sent. */
  signal: AbortSignal;
  onEvent: (event: TranscriptEvent) => void;
  onOpen?: () => void;
  now?: () => number;
}

/**
 * One Deepgram connection, from opening to closed.
 *
 * `run()` resolves once the attempt is stopped through its signal, and
 * rejects when the connection fails: it could not open, it closed on its own,
 * or it stopped answering. Either way it has closed its socket and emitted an
 * `interrupt`, so whatever utterance this connection had open is finished
 * before the next connection starts.
 *
 * The attempt owns its timeline: Deepgram's offsets restart on every
 * connection, and only the audio this connection sent can place them.
 */
export class DeepgramAttempt {
  private socket: DeepgramSocket | null = null;

  constructor(private readonly options: DeepgramAttemptOptions) {}

  /** Ask Deepgram to commit what it has heard so far. */
  finalize(): void {
    try {
      this.socket?.finalize();
    } catch {
      // A closed socket has nothing to finalize; its close interrupts the utterance.
    }
  }

  async run(): Promise<void> {
    const { signal, language } = this.options;
    const now = this.options.now ?? Date.now;
    if (signal.aborted) return;

    const opening = this.options.open(language);
    let socket: DeepgramSocket;
    try {
      socket = await abortable(opening, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      void opening.then((late) => late.close(), () => undefined);
      return;
    }

    let closed = false;
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    // What the send loop waits on: the attempt stopping, or the socket
    // closing. One signal for the whole attempt, so each wait registers one
    // listener and removes it again.
    const wake = childController(signal);
    socket.onClose(() => {
      closed = true;
      resolveClosed();
      wake.abort();
    });
    const timeline = new AudioTimeline();
    const liveness = { lastInboundAt: now(), lastSpeechSentAt: 0 };
    socket.onMessage((message) => {
      liveness.lastInboundAt = now();
      this.handleMessage(message, timeline);
    });

    try {
      await abortable(
        withDeadline(socket.waitForOpen(), CONNECTION_OPEN_TIMEOUT_MS, "Deepgram connection timed out while opening"),
        signal,
      );
    } catch (error) {
      socket.close();
      if (signal.aborted) return;
      throw error;
    }

    this.socket = socket;
    this.options.onOpen?.();
    logInfo("Deepgram transcription stream connected", { language });
    const keepAlive = setInterval(() => {
      try {
        socket.keepAlive();
      } catch {
        // The close handler owns recovery.
      }
    }, KEEP_ALIVE_INTERVAL_MS);

    let failed = true;
    try {
      await this.pump(socket, timeline, liveness, () => closed, wake.signal);
      failed = false;
    } finally {
      wake.abort();
      clearInterval(keepAlive);
      this.socket = null;
      if (!closed && !failed) {
        // Stopping on purpose: let Deepgram return what it was sent.
        try {
          socket.closeStream();
          await Promise.race([closedPromise, sleep(GRACEFUL_CLOSE_TIMEOUT_MS)]);
        } catch {
          // Already closing.
        }
      }
      if (!closed) socket.close();
      this.options.onEvent({ kind: "interrupt" });
    }
  }

  private async pump(
    socket: DeepgramSocket,
    timeline: AudioTimeline,
    liveness: { lastInboundAt: number; lastSpeechSentAt: number },
    isClosed: () => boolean,
    wake: AbortSignal,
  ): Promise<void> {
    const { signal, source } = this.options;
    const now = this.options.now ?? Date.now;
    while (!signal.aborted) {
      if (isClosed()) throw new Error("Deepgram connection closed unexpectedly");
      const silentFor = now() - liveness.lastInboundAt;
      if (liveness.lastSpeechSentAt >= liveness.lastInboundAt && silentFor >= INBOUND_LIVENESS_TIMEOUT_MS) {
        throw new Error(`Deepgram stopped answering ${silentFor}ms after speech audio`);
      }

      const chunk = source.peek();
      if (!chunk) {
        // Bounded, so liveness is still checked while the microphone is muted.
        await source.ready(wake, LIVENESS_CHECK_INTERVAL_MS);
        continue;
      }
      const likelySpeech = containsLikelySpeech(chunk.samples);
      // After a long quiet stretch nothing proves the socket is still there.
      // Reconnect before sending the first speech rather than feeding the
      // opening of an utterance into a half-open socket; the chunk stays
      // buffered for the next connection.
      if (likelySpeech && silentFor >= INBOUND_LIVENESS_TIMEOUT_MS) {
        throw new Error(`Deepgram was silent for ${silentFor}ms before speech resumed`);
      }
      try {
        socket.sendAudio(chunk.samples);
      } catch (error) {
        throw new Error("Deepgram connection refused audio", { cause: error });
      }
      if (likelySpeech) liveness.lastSpeechSentAt = now();
      timeline.record(chunk);
      source.shift();
      if (source.bufferedMs > chunk.durationMs) {
        await sleep(chunk.durationMs / CATCH_UP_RATE, wake);
      }
    }
  }

  private handleMessage(message: DeepgramMessage, timeline: AudioTimeline): void {
    const now = this.options.now ?? Date.now;
    if (message.type === "UtteranceEnd") {
      this.options.onEvent({ kind: "utterance-end" });
      return;
    }
    if (!isResults(message)) return;
    const startMs = message.start * 1_000;
    const start = timeline.at(startMs);
    const end = timeline.at(startMs + message.duration * 1_000);
    this.options.onEvent({
      kind: "words",
      text: message.channel?.alternatives?.[0]?.transcript ?? "",
      isFinal: message.is_final === true,
      endpoint: message.speech_final === true,
      fromFinalize: message.from_finalize === true,
      startedAt: start?.capturedAt ?? null,
      endedAt: end?.capturedAt ?? null,
      trackSid: start?.trackSid ?? null,
      language: this.options.language,
      receivedAt: now(),
    });
  }
}

function isResults(message: DeepgramMessage): message is Extract<DeepgramMessage, { type: "Results" }> {
  return message.type === "Results" && typeof (message as { start?: unknown }).start === "number";
}

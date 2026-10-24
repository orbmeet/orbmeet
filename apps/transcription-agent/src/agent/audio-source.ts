import { AudioStream, type AudioFrame, type RemoteAudioTrack } from "@livekit/rtc-node";
import { logError, logWarn } from "../log.js";

export const SAMPLE_RATE = 16_000;
const MAX_BUFFERED_AUDIO_MS = 30_000;
const DROP_WARNING_INTERVAL_MS = 5_000;
const SPEECH_SAMPLE_THRESHOLD = 500;

export interface AudioChunk {
  samples: Int16Array;
  /** Receiver-clock time the chunk was read from the track. */
  capturedAt: number;
  durationMs: number;
  trackSid: string;
}

type FrameReader = Pick<ReadableStreamDefaultReader<AudioFrame>, "read" | "cancel">;
export type OpenFrameReader = (track: RemoteAudioTrack) => FrameReader;

interface Attachment {
  track: RemoteAudioTrack;
  trackSid: string;
  reader: FrameReader;
  done: Promise<void>;
}

function openAudioStream(track: RemoteAudioTrack): FrameReader {
  return new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: 1, frameSizeMs: 20 }).getReader();
}

/** Whether a chunk holds enough non-silent samples to be worth a transcript. */
export function containsLikelySpeech(samples: Int16Array): boolean {
  const requiredSamples = Math.max(3, Math.ceil(samples.length / 100));
  let aboveThreshold = 0;
  for (const sample of samples) {
    if (Math.abs(sample) < SPEECH_SAMPLE_THRESHOLD) continue;
    aboveThreshold += 1;
    if (aboveThreshold >= requiredSamples) return true;
  }
  return false;
}

/**
 * The publisher's microphone audio, buffered until a Deepgram connection sends it.
 *
 * One source serves the whole job. A republished microphone is a new track
 * attached to the same source, so there is never a second transcriber to
 * retire: the connection keeps consuming the one buffer, and each chunk says
 * which track it came from. The buffer is bounded; while no connection drains
 * it, the oldest audio is dropped.
 */
export class AudioSource {
  private readonly buffer: AudioChunk[] = [];
  private bufferedDurationMs = 0;
  private attachment: Attachment | null = null;
  private waiters = new Set<() => void>();
  private closed = false;
  private accepting = true;
  private droppedSinceWarningMs = 0;
  private lastDropWarningAt = 0;

  constructor(
    private readonly options: {
      openReader?: OpenFrameReader;
      maxBufferedMs?: number;
      now?: () => number;
      onAudioDropped?: (droppedMs: number) => void;
    } = {},
  ) {}

  /** The track whose audio is being read, if any. */
  get trackSid(): string | null {
    return this.attachment?.trackSid ?? null;
  }

  get bufferedMs(): number {
    return this.bufferedDurationMs;
  }

  /** Read `track` from now on, in place of whatever was read before. */
  attach(track: RemoteAudioTrack, trackSid: string): void {
    // A resubscription can deliver a new track under the same publication SID;
    // only the very same track is already being read.
    if (this.closed || this.attachment?.track === track) return;
    this.stopReading();
    const reader = (this.options.openReader ?? openAudioStream)(track);
    const attachment: Attachment = { track, trackSid, reader, done: Promise.resolve() };
    this.attachment = attachment;
    attachment.done = this.read(attachment);
  }

  /**
   * Whether audio is kept for transcription. While the meeting has
   * transcription off nothing may reach Deepgram, later included: what is
   * buffered is discarded and what arrives is dropped, so turning it back on
   * starts from that moment rather than sending the gap.
   */
  setAccepting(accepting: boolean): void {
    if (this.accepting === accepting) return;
    this.accepting = accepting;
    if (accepting) return;
    this.buffer.length = 0;
    this.bufferedDurationMs = 0;
  }

  /** Stop reading `trackSid`, if it is the track being read. Buffered audio stays. */
  detach(trackSid: string): void {
    if (this.attachment?.trackSid === trackSid) this.stopReading();
  }

  peek(): AudioChunk | undefined {
    return this.buffer[0];
  }

  shift(): void {
    const chunk = this.buffer.shift();
    if (chunk) this.bufferedDurationMs -= chunk.durationMs;
  }

  /**
   * Resolves once a chunk is buffered, when `signal` aborts, or after
   * `timeoutMs`. However it resolves, it leaves nothing registered behind: a
   * caller that waits in a loop while the microphone is muted must not
   * accumulate a waiter per wait.
   */
  ready(signal: AbortSignal, timeoutMs?: number): Promise<void> {
    if (this.buffer.length > 0 || signal.aborted || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(done, timeoutMs);
    });
  }

  /** How many callers are waiting for audio. */
  get waiting(): number {
    return this.waiters.size;
  }

  async close(): Promise<void> {
    this.closed = true;
    const attachment = this.attachment;
    this.stopReading();
    await attachment?.done;
    this.buffer.length = 0;
    this.bufferedDurationMs = 0;
    for (const wake of this.waiters) wake();
  }

  private stopReading(): void {
    const attachment = this.attachment;
    this.attachment = null;
    void attachment?.reader.cancel().catch(() => undefined);
  }

  private async read(attachment: Attachment): Promise<void> {
    try {
      while (this.attachment === attachment) {
        const { done, value } = await attachment.reader.read();
        if (done || !value || this.attachment !== attachment) return;
        this.push({
          samples: value.data.slice(),
          capturedAt: (this.options.now ?? Date.now)(),
          durationMs: (value.samplesPerChannel / value.sampleRate) * 1_000,
          trackSid: attachment.trackSid,
        });
      }
    } catch (error) {
      if (this.attachment !== attachment) return;
      // The track's stream failed. Nothing more will come from it; LiveKit
      // resubscribes a republished microphone, which attaches a new track.
      logError("LiveKit microphone audio stream failed", { trackSid: attachment.trackSid, error });
      this.attachment = null;
    }
  }

  private push(chunk: AudioChunk): void {
    if (!this.accepting) return;
    this.buffer.push(chunk);
    this.bufferedDurationMs += chunk.durationMs;
    const maxBufferedMs = this.options.maxBufferedMs ?? MAX_BUFFERED_AUDIO_MS;
    let droppedMs = 0;
    while (this.bufferedDurationMs > maxBufferedMs && this.buffer.length > 1) {
      const dropped = this.buffer.shift()!;
      this.bufferedDurationMs -= dropped.durationMs;
      droppedMs += dropped.durationMs;
    }
    if (droppedMs > 0) this.reportDrop(droppedMs);
    for (const wake of this.waiters) wake();
  }

  private reportDrop(droppedMs: number): void {
    this.options.onAudioDropped?.(droppedMs);
    this.droppedSinceWarningMs += droppedMs;
    const now = (this.options.now ?? Date.now)();
    if (now - this.lastDropWarningAt < DROP_WARNING_INTERVAL_MS) return;
    this.lastDropWarningAt = now;
    logWarn("Transcription audio buffer dropped captured audio", {
      trackSid: this.trackSid,
      droppedSinceLastWarningMs: Math.round(this.droppedSinceWarningMs),
      bufferedAudioMs: Math.round(this.bufferedDurationMs),
    });
    this.droppedSinceWarningMs = 0;
  }
}

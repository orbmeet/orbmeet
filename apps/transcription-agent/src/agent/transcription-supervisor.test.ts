import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@livekit/rtc-node", () => ({ AudioStream: class {} }));
vi.mock("../outbox/transcription-health.js", () => ({
  recordTranscriptionConnectionStatus: vi.fn(),
  removeTranscriptionConnectionStatus: vi.fn(),
}));

import { recordTranscriptionConnectionStatus } from "../outbox/transcription-health.js";
import { AudioSource } from "./audio-source.js";
import type { DeepgramMessage, DeepgramSocket } from "./deepgram-attempt.js";
import { TranscriptionSupervisor } from "./transcription-supervisor.js";

/** A Deepgram socket that answers every chunk of audio at once. */
class AnsweringSocket implements DeepgramSocket {
  readonly sent: number[] = [];
  private onMessageHandler: ((message: DeepgramMessage) => void) | null = null;
  private onCloseHandler: (() => void) | null = null;
  private closed = false;
  onMessage(handler: (message: DeepgramMessage) => void) { this.onMessageHandler = handler; }
  onClose(handler: () => void) { this.onCloseHandler = handler; if (this.closed) handler(); }
  async waitForOpen() {}
  sendAudio() {
    this.sent.push(Date.now());
    queueMicrotask(() => this.onMessageHandler?.({
      type: "Results", start: 0, duration: 0.02, channel: { alternatives: [{ transcript: "" }] },
    }));
  }
  keepAlive() {}
  finalize() {}
  closeStream() { queueMicrotask(() => this.close()); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onCloseHandler?.();
  }
}

function speak(source: AudioSource) {
  const samples = new Int16Array(320).fill(2_000);
  (source as unknown as { push(chunk: unknown): void }).push({ samples, capturedAt: Date.now(), durationMs: 20, trackSid: "TR" });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TranscriptionSupervisor", () => {
  it("replaces a quiet socket before speech without backing off or calling it failed", async () => {
    // Someone who unmutes for a few seconds now and then: each time, the
    // socket has been quiet past the liveness timeout and is replaced first.
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const source = new AudioSource();
    const sockets: AnsweringSocket[] = [];
    const supervisor = new TranscriptionSupervisor({
      source,
      open: async () => {
        const socket = new AnsweringSocket();
        sockets.push(socket);
        return socket;
      },
      language: "en-US",
      enabled: true,
      onEvent: () => undefined,
      id: "job-1",
    });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(10);

    const lags: number[] = [];
    for (let turn = 0; turn < 8; turn += 1) {
      const spokeAt = Date.now();
      const sentBefore = sockets.reduce((count, socket) => count + socket.sent.length, 0);
      for (let i = 0; i < 150; i += 1) {
        speak(source);
        await vi.advanceTimersByTimeAsync(20);
      }
      let firstSent: number | undefined;
      for (let waited = 0; firstSent === undefined && waited < 60_000; waited += 50) {
        firstSent = sockets.flatMap((socket) => socket.sent).sort((a, b) => a - b)[sentBefore];
        if (firstSent === undefined) await vi.advanceTimersByTimeAsync(50);
      }
      lags.push(firstSent! - spokeAt);
      while (source.bufferedMs > 0) await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(22_000);
    }

    expect(Math.max(...lags)).toBeLessThan(1_000);
    expect(vi.mocked(recordTranscriptionConnectionStatus).mock.calls.filter(([, status]) => status === "failed")).toEqual([]);
    await supervisor.close();
  });
});

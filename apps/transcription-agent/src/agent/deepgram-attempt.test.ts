import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@livekit/rtc-node", () => ({ AudioStream: class {} }));
vi.mock("../outbox/transcription-health.js", () => ({
  recordTranscriptionConnectionStatus: vi.fn(),
  removeTranscriptionConnectionStatus: vi.fn(),
}));

import { AudioSource } from "./audio-source.js";
import { DeepgramAttempt, type DeepgramMessage, type DeepgramSocket } from "./deepgram-attempt.js";
import { TranscriptionSupervisor } from "./transcription-supervisor.js";
import type { TranscriptEvent } from "./transcript-assembler.js";
import { recordTranscriptionConnectionStatus } from "../outbox/transcription-health.js";

class FakeSocket implements DeepgramSocket {
  readonly sent: Int16Array[] = [];
  readonly control: string[] = [];
  opened!: () => void;
  failOpen!: (error: Error) => void;
  private readonly openPromise = new Promise<void>((resolve, reject) => {
    this.opened = resolve;
    this.failOpen = reject;
  });
  private messageHandler: ((message: DeepgramMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private isClosed = false;

  constructor(readonly language: string, private readonly closeOnCloseStream = true) {}

  onMessage(handler: (message: DeepgramMessage) => void) { this.messageHandler = handler; }
  onClose(handler: () => void) {
    this.closeHandler = handler;
    if (this.isClosed) handler();
  }
  waitForOpen() { return this.openPromise; }
  sendAudio(samples: Int16Array) {
    if (this.isClosed) throw new Error("Socket is not open.");
    this.sent.push(samples);
  }
  keepAlive() { this.control.push("KeepAlive"); }
  finalize() { this.control.push("Finalize"); }
  closeStream() {
    this.control.push("CloseStream");
    if (this.closeOnCloseStream) queueMicrotask(() => this.serverClose());
  }
  close() {
    this.control.push("close");
    this.serverClose();
  }
  serverClose() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closeHandler?.();
  }
  emit(message: DeepgramMessage) { this.messageHandler?.(message); }
}

function results(transcript: string, fields: Partial<{ start: number; duration: number; is_final: boolean; speech_final: boolean }> = {}): DeepgramMessage {
  return { type: "Results", start: 0, duration: 0.02, channel: { alternatives: [{ transcript }] }, ...fields };
}

/** A source with chunks placed directly in its buffer, as its reader would. */
function sourceWith(chunks: Array<{ capturedAt: number; speech?: boolean; trackSid?: string }> = []) {
  const source = new AudioSource();
  const buffer = (source as unknown as { buffer: unknown[]; bufferedDurationMs: number });
  for (const chunk of chunks) {
    const samples = new Int16Array(320);
    if (chunk.speech) samples.fill(2_000);
    buffer.buffer.push({ samples, capturedAt: chunk.capturedAt, durationMs: 20, trackSid: chunk.trackSid ?? "TR_mic" });
    buffer.bufferedDurationMs += 20;
  }
  return source;
}

function pushChunk(source: AudioSource, chunk: { capturedAt: number; speech?: boolean }) {
  const samples = new Int16Array(320);
  if (chunk.speech) samples.fill(2_000);
  (source as unknown as { push(chunk: unknown): void }).push({ samples, capturedAt: chunk.capturedAt, durationMs: 20, trackSid: "TR_mic" });
}

beforeEach(() => {
  vi.mocked(recordTranscriptionConnectionStatus).mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DeepgramAttempt", () => {
  it("sends buffered audio and places results on the capture clock and track", async () => {
    const socket = new FakeSocket("en-US");
    const events: TranscriptEvent[] = [];
    const scope = new AbortController();
    const attempt = new DeepgramAttempt({
      open: async () => socket,
      language: "en-US",
      source: sourceWith([{ capturedAt: 1_000 }, { capturedAt: 5_000, trackSid: "TR_new" }]),
      signal: scope.signal,
      onEvent: (event) => events.push(event),
    });
    const running = attempt.run();
    socket.opened();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));

    socket.emit(results("hello", { start: 0.025, duration: 0.01, is_final: true, speech_final: true }));
    expect(events[0]).toMatchObject({
      kind: "words",
      text: "hello",
      isFinal: true,
      endpoint: true,
      startedAt: 5_005,
      endedAt: 5_015,
      trackSid: "TR_new",
      language: "en-US",
    });
    socket.emit({ type: "UtteranceEnd" });
    expect(events[1]).toEqual({ kind: "utterance-end" });

    scope.abort();
    await running;
  });

  it("stops gracefully: Deepgram's last results arrive before the interrupt that ends the attempt", async () => {
    const socket = new FakeSocket("en-US", false);
    const events: TranscriptEvent[] = [];
    const scope = new AbortController();
    const running = new DeepgramAttempt({
      open: async () => socket,
      language: "en-US",
      source: sourceWith([{ capturedAt: 1_000 }]),
      signal: scope.signal,
      onEvent: (event) => events.push(event),
    }).run();
    socket.opened();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    scope.abort();
    await vi.waitFor(() => expect(socket.control).toContain("CloseStream"));
    socket.emit(results("last words", { is_final: true }));
    socket.serverClose();
    await running;

    expect(events.map((event) => event.kind)).toEqual(["words", "interrupt"]);
    expect(socket.control).not.toContain("close");
  });

  it("fails when the connection closes on its own, and still ends the utterance", async () => {
    const socket = new FakeSocket("en-US");
    const events: TranscriptEvent[] = [];
    const running = new DeepgramAttempt({
      open: async () => socket,
      language: "en-US",
      source: sourceWith(),
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    }).run();
    socket.opened();
    await Promise.resolve();
    socket.serverClose();

    await expect(running).rejects.toThrow("closed unexpectedly");
    expect(events).toEqual([{ kind: "interrupt" }]);
  });

  it("returns at once when stopped while the socket is still opening, and closes it when it arrives", async () => {
    const socket = new FakeSocket("en-US");
    let deliver!: (socket: FakeSocket) => void;
    const scope = new AbortController();
    const running = new DeepgramAttempt({
      open: () => new Promise((resolve) => {
        deliver = resolve;
      }),
      language: "en-US",
      source: sourceWith(),
      signal: scope.signal,
      onEvent: () => undefined,
    }).run();
    scope.abort();
    await running;

    deliver(socket);
    await vi.waitFor(() => expect(socket.control).toContain("close"));
  });

  it("reconnects before speech that follows a long silence from Deepgram, keeping the speech buffered", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket("en-US");
    const source = sourceWith();
    const running = new DeepgramAttempt({
      open: async () => socket,
      language: "en-US",
      source,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    }).run();
    const failure = running.then(() => null, (error: unknown) => error);
    socket.opened();
    await vi.advanceTimersByTimeAsync(21_000);
    pushChunk(source, { capturedAt: Date.now(), speech: true });
    await vi.advanceTimersByTimeAsync(10);

    expect(await failure).toMatchObject({ message: expect.stringContaining("silent") });
    expect(socket.sent).toHaveLength(0);
    expect(source.bufferedMs).toBe(20);
  });

  it("gives up on a socket that stops answering after it was sent speech", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket("en-US");
    const running = new DeepgramAttempt({
      open: async () => socket,
      language: "en-US",
      source: sourceWith([{ capturedAt: 0, speech: true }]),
      signal: new AbortController().signal,
      onEvent: () => undefined,
    }).run();
    const failure = running.then(() => null, (error: unknown) => error);
    socket.opened();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(await failure).toMatchObject({ message: expect.stringContaining("stopped answering") });
  });

  it("does not accumulate waiters or listeners while the microphone is muted", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket("en-US");
    const source = sourceWith();
    const scope = new AbortController();
    let listeners = 0;
    const add = scope.signal.addEventListener.bind(scope.signal);
    const remove = scope.signal.removeEventListener.bind(scope.signal);
    scope.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listeners += 1;
      add(...args);
    }) as typeof add;
    scope.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      listeners -= 1;
      remove(...args);
    }) as typeof remove;
    const running = new DeepgramAttempt({
      open: async () => socket,
      language: "en-US",
      source,
      signal: scope.signal,
      onEvent: () => undefined,
    }).run();
    socket.opened();
    await vi.advanceTimersByTimeAsync(0);
    const settled = listeners;

    // An hour muted: no audio, Deepgram answering keep-alives with nothing.
    for (let second = 0; second < 3_600; second += 60) {
      socket.emit({ type: "Metadata" });
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(source.waiting).toBeLessThanOrEqual(1);
    expect(listeners).toBeLessThanOrEqual(settled);

    scope.abort();
    await vi.advanceTimersByTimeAsync(0);
    socket.serverClose();
    await running;
  });

  it("forwards Finalize to the open socket", async () => {
    const socket = new FakeSocket("en-US");
    const scope = new AbortController();
    const attempt = new DeepgramAttempt({
      open: async () => socket,
      language: "en-US",
      source: sourceWith(),
      signal: scope.signal,
      onEvent: () => undefined,
    });
    const running = attempt.run();
    socket.opened();
    await vi.waitFor(() => {
      attempt.finalize();
      expect(socket.control).toContain("Finalize");
    });
    scope.abort();
    await running;
  });
});

describe("TranscriptionSupervisor", () => {
  function supervisor(open: (language: string) => Promise<DeepgramSocket>, onEvent: (event: TranscriptEvent) => void = () => undefined) {
    return new TranscriptionSupervisor({ source: sourceWith(), open, language: "en-US", onEvent, id: "job-1" });
  }

  it("opens a fresh connection after one fails", async () => {
    const sockets: FakeSocket[] = [];
    const open = vi.fn(async (language: string) => {
      const socket = new FakeSocket(language);
      sockets.push(socket);
      queueMicrotask(() => socket.opened());
      return socket;
    });
    const transcription = supervisor(open);
    transcription.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await vi.waitFor(() => expect(recordTranscriptionConnectionStatus).toHaveBeenCalledWith("job-1", "connected"));
    sockets[0].serverClose();

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await transcription.close();
  });

  it("reopens in the new language after the current connection finishes gracefully", async () => {
    const sockets: FakeSocket[] = [];
    const open = vi.fn(async (language: string) => {
      const socket = new FakeSocket(language);
      sockets.push(socket);
      queueMicrotask(() => socket.opened());
      return socket;
    });
    const transcription = supervisor(open);
    transcription.start();
    await vi.waitFor(() => expect(recordTranscriptionConnectionStatus).toHaveBeenCalledWith("job-1", "connected"));

    transcription.setLanguage("fr");
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[0].control).toContain("CloseStream");
    expect(sockets[1].language).toBe("fr");
    await transcription.close();
  });

  it("holds no connection while transcription is off, and sends none of the audio from then", async () => {
    const sockets: FakeSocket[] = [];
    const open = vi.fn(async (language: string) => {
      const socket = new FakeSocket(language);
      sockets.push(socket);
      queueMicrotask(() => socket.opened());
      return socket;
    });
    const source = sourceWith();
    const transcription = new TranscriptionSupervisor({ source, open, language: "en-US", onEvent: () => undefined, id: "job-1" });
    transcription.start();
    await vi.waitFor(() => expect(recordTranscriptionConnectionStatus).toHaveBeenCalledWith("job-1", "connected"));

    transcription.setEnabled(false);
    await vi.waitFor(() => expect(sockets[0].control).toContain("CloseStream"));
    // Speech while it is off is never buffered for a later connection.
    pushChunk(source, { capturedAt: 1_000, speech: true });
    expect(source.bufferedMs).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets).toHaveLength(1);

    transcription.setEnabled(true);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1].sent).toEqual([]);
    pushChunk(source, { capturedAt: 2_000, speech: true });
    await vi.waitFor(() => expect(sockets[1].sent.length).toBeGreaterThan(0));
    await transcription.close();
  });

  it("never connects when the meeting starts with transcription off", async () => {
    const open = vi.fn(async (language: string) => new FakeSocket(language));
    const source = sourceWith([{ capturedAt: 0, speech: true }]);
    const transcription = new TranscriptionSupervisor({
      source,
      open,
      language: "en-US",
      enabled: false,
      onEvent: () => undefined,
      id: "job-1",
    });
    transcription.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(open).not.toHaveBeenCalled();
    expect(source.bufferedMs).toBe(0);
    await transcription.close();
  });

  it("closes at once while a connection is failing to open", async () => {
    const open = vi.fn(() => new Promise<DeepgramSocket>(() => undefined));
    const transcription = supervisor(open);
    transcription.start();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());

    const started = Date.now();
    await transcription.close();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("closes at once while waiting to retry", async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => {
      throw new Error("Deepgram refused the connection");
    });
    const transcription = supervisor(open);
    transcription.start();
    // Burn through the fast retries into a long backoff.
    await vi.advanceTimersByTimeAsync(5_000);
    const calls = open.mock.calls.length;

    const closing = transcription.close();
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(open.mock.calls.length).toBe(calls);
  });

  it("backs off from a connection that opens and drops at once, and reports it failed", async () => {
    vi.useFakeTimers();
    const open = vi.fn(async (language: string) => {
      const socket = new FakeSocket(language);
      queueMicrotask(() => {
        socket.opened();
        queueMicrotask(() => socket.serverClose());
      });
      return socket;
    });
    const transcription = supervisor(open);
    transcription.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // The ladder is 0, 0.25, 1, 3, 8, 15 and 30 seconds: a handful of
    // attempts a minute, not one per tick.
    expect(open.mock.calls.length).toBeLessThanOrEqual(10);
    expect(recordTranscriptionConnectionStatus).toHaveBeenCalledWith("job-1", "failed", expect.any(Error));
    await transcription.close();
  });

  it("starts the backoff over after a connection that stayed up", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const open = vi.fn(async (language: string) => {
      const socket = new FakeSocket(language);
      sockets.push(socket);
      queueMicrotask(() => socket.opened());
      return socket;
    });
    const transcription = supervisor(open);
    transcription.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let drop = 0; drop < 4; drop += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      sockets.at(-1)!.serverClose();
      // Reconnects straight away every time: each connection had been healthy.
      await vi.advanceTimersByTimeAsync(10);
      expect(sockets).toHaveLength(drop + 2);
    }
    await transcription.close();
  });

  it("ends a muted utterance itself when Deepgram does not answer Finalize", async () => {
    vi.useFakeTimers();
    const events: TranscriptEvent[] = [];
    const transcription = supervisor(() => new Promise(() => undefined), (event) => events.push(event));
    transcription.finalize();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events).toEqual([{ kind: "interrupt" }]);

    transcription.finalize();
    transcription.cancelFinalize();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events).toHaveLength(1);
    await transcription.close();
  });
});

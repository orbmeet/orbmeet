import { describe, expect, it, vi } from "vitest";

vi.mock("@livekit/rtc-node", () => ({ AudioStream: class {} }));

import type { RemoteAudioTrack } from "@livekit/rtc-node";
import { AudioSource, containsLikelySpeech } from "./audio-source.js";

class FakeReader {
  private pending: ((result: ReadableStreamReadResult<unknown>) => void) | null = null;
  cancelled = false;

  read() {
    if (this.cancelled) return Promise.resolve({ done: true as const, value: undefined });
    return new Promise<ReadableStreamReadResult<unknown>>((resolve) => {
      this.pending = resolve;
    });
  }

  async cancel() {
    this.cancelled = true;
    this.pending?.({ done: true, value: undefined });
    this.pending = null;
  }

  push(samples = 320) {
    const resolve = this.pending;
    this.pending = null;
    resolve?.({ done: false, value: { data: new Int16Array(samples), samplesPerChannel: samples, sampleRate: 16_000 } });
  }
}

function track(): RemoteAudioTrack {
  return {} as RemoteAudioTrack;
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe("AudioSource", () => {
  it("buffers each frame with its capture time and track", async () => {
    const reader = new FakeReader();
    const source = new AudioSource({ openReader: () => reader as never, now: () => 5_000 });
    source.attach(track(), "TR_a");
    await settle();
    reader.push();
    await settle();

    expect(source.peek()).toMatchObject({ capturedAt: 5_000, durationMs: 20, trackSid: "TR_a" });
    expect(source.bufferedMs).toBe(20);
    source.shift();
    expect(source.bufferedMs).toBe(0);
    await source.close();
  });

  it("moves to a republished microphone, keeping what the old one buffered", async () => {
    const readers = [new FakeReader(), new FakeReader()];
    const source = new AudioSource({ openReader: () => readers.shift()! as never });
    const first = readers[0];
    source.attach(track(), "TR_a");
    await settle();
    first.push();
    await settle();

    const second = readers[0];
    source.attach(track(), "TR_a");
    await settle();
    expect(first.cancelled).toBe(true);
    second.push();
    await settle();
    expect(source.bufferedMs).toBe(40);
    await source.close();
  });

  it("does not reopen the very same track", () => {
    const openReader = vi.fn(() => new FakeReader() as never);
    const source = new AudioSource({ openReader });
    const same = track();
    source.attach(same, "TR_a");
    source.attach(same, "TR_a");
    expect(openReader).toHaveBeenCalledOnce();
  });

  it("drops the oldest audio past its bound and reports it", async () => {
    const reader = new FakeReader();
    const onAudioDropped = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = new AudioSource({ openReader: () => reader as never, maxBufferedMs: 40, onAudioDropped });
    source.attach(track(), "TR_a");
    for (let frame = 0; frame < 3; frame += 1) {
      await settle();
      reader.push();
    }
    await settle();
    expect(source.bufferedMs).toBe(40);
    expect(onAudioDropped).toHaveBeenCalledWith(20);
    await source.close();
  });

  it("wakes a waiting connection when audio arrives, and when its scope aborts", async () => {
    const reader = new FakeReader();
    const source = new AudioSource({ openReader: () => reader as never });
    source.attach(track(), "TR_a");
    const woken = vi.fn();
    void source.ready(new AbortController().signal).then(woken);
    await settle();
    expect(woken).not.toHaveBeenCalled();
    reader.push();
    await settle();
    expect(woken).toHaveBeenCalledOnce();

    source.shift();
    const scope = new AbortController();
    const aborted = vi.fn();
    void source.ready(scope.signal).then(aborted);
    scope.abort();
    await settle();
    expect(aborted).toHaveBeenCalledOnce();
    await source.close();
  });

  it("leaves no waiter behind when a bounded wait times out", async () => {
    vi.useFakeTimers();
    try {
      const source = new AudioSource({ openReader: () => new FakeReader() as never });
      const scope = new AbortController();
      for (let wait = 0; wait < 100; wait += 1) {
        const waiting = source.ready(scope.signal, 1_000);
        await vi.advanceTimersByTimeAsync(1_000);
        await waiting;
      }
      expect(source.waiting).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("containsLikelySpeech", () => {
  it("distinguishes sustained voice-level samples from silence and isolated clicks", () => {
    expect(containsLikelySpeech(new Int16Array(320))).toBe(false);
    const click = new Int16Array(320);
    click[0] = 10_000;
    expect(containsLikelySpeech(click)).toBe(false);
    const speech = new Int16Array(320);
    speech.fill(1_000, 0, 8);
    expect(containsLikelySpeech(speech)).toBe(true);
  });
});

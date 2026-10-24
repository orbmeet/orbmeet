import { parseCaptionStreamAttributes } from "@orbmeet/caption-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptionPublisher, type CaptionTransport } from "./caption-publisher.js";
import type { CaptionUpdate } from "./transcript-assembler.js";

function update(segmentId: string, text: string, isFinal = false): CaptionUpdate {
  return { segmentId, trackSid: "TR_mic", text, isFinal, language: "en-US" };
}

/** A transport whose writes can be held open to simulate a stalled connection. */
function transport() {
  const sent: Array<{ segmentId: string; revision: number; isFinal: boolean; text: string; sender: string }> = [];
  const closed: string[] = [];
  let hold: Promise<void> | null = null;
  const fake: CaptionTransport = {
    streamText: vi.fn(async ({ attributes, senderIdentity }) => {
      const caption = parseCaptionStreamAttributes(attributes)!;
      let text = "";
      return {
        write: async (chunk: string) => {
          text += chunk;
          if (hold) await hold;
        },
        close: async () => {
          sent.push({ segmentId: caption.segmentId, revision: caption.revision, isFinal: caption.isFinal, text, sender: senderIdentity });
          closed.push(caption.segmentId);
        },
      };
    }),
  };
  return {
    fake,
    sent,
    closed,
    stall() {
      let release!: () => void;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        hold = null;
        release();
      };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CaptionPublisher", () => {
  it("sends each update as the speaker, with a revision that rises within its segment", async () => {
    const { fake, sent } = transport();
    const publisher = new CaptionPublisher({ transport: () => fake, senderIdentity: "participant-1" });
    publisher.offer(update("s1", "hel"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    publisher.offer(update("s1", "hello", true));
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    expect(sent).toEqual([
      { segmentId: "s1", revision: 1, isFinal: false, text: "hel", sender: "participant-1" },
      { segmentId: "s1", revision: 2, isFinal: true, text: "hello", sender: "participant-1" },
    ]);
  });

  it("sends only the newest update of a segment that queued behind a stall", async () => {
    const { fake, sent, stall } = transport();
    const publisher = new CaptionPublisher({ transport: () => fake, senderIdentity: "p" });
    const release = stall();
    publisher.offer(update("s0", "blocking"));
    await vi.waitFor(() => expect(fake.streamText).toHaveBeenCalledOnce());
    for (const text of ["a", "a b", "a b c"]) publisher.offer(update("s1", text));
    publisher.offer(update("s1", "a b c d", true));
    release();

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ segmentId: "s1", text: "a b c d", isFinal: true, revision: 4 });
  });

  it("keeps a bounded number of waiting segments, dropping the oldest", async () => {
    const { fake, sent, stall } = transport();
    const publisher = new CaptionPublisher({ transport: () => fake, senderIdentity: "p", maxPendingSegments: 2 });
    const release = stall();
    publisher.offer(update("s0", "blocking"));
    await vi.waitFor(() => expect(fake.streamText).toHaveBeenCalledOnce());
    publisher.offer(update("s1", "one"));
    publisher.offer(update("s2", "two"));
    publisher.offer(update("s3", "three"));
    release();

    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((caption) => caption.segmentId)).toEqual(["s0", "s2", "s3"]);
  });

  it("numbers a dropped segment's later updates above what receivers already have", async () => {
    const { fake, sent, stall } = transport();
    const publisher = new CaptionPublisher({ transport: () => fake, senderIdentity: "p", maxPendingSegments: 2 });
    publisher.offer(update("s1", "hel"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const release = stall();
    publisher.offer(update("s0", "blocking"));
    await vi.waitFor(() => expect(fake.streamText).toHaveBeenCalledTimes(2));
    publisher.offer(update("s1", "hello"));
    publisher.offer(update("s2", "two"));
    publisher.offer(update("s3", "three"));
    publisher.offer(update("s1", "hello world", true));
    release();

    await vi.waitFor(() => expect(sent).toHaveLength(4));
    expect(sent.find((caption) => caption.segmentId === "s1" && caption.isFinal)).toMatchObject({
      text: "hello world",
      revision: 3,
    });
  });

  it("moves past a publish that never finishes, and still closes its stream when it does", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { fake, sent, closed, stall } = transport();
    const publisher = new CaptionPublisher({ transport: () => fake, senderIdentity: "p", publishTimeoutMs: 20 });
    const release = stall();
    publisher.offer(update("stuck", "never lands"));
    publisher.offer(update("next", "lands"));
    await vi.waitFor(() => expect(fake.streamText).toHaveBeenCalledTimes(2));
    expect(closed).not.toContain("stuck");

    release();
    await vi.waitFor(() => expect(closed).toEqual(expect.arrayContaining(["stuck", "next"])));
    expect(sent.map((caption) => caption.segmentId)).toContain("next");
  });

  it("sends a withdrawn segment as an empty final", async () => {
    const { fake, sent } = transport();
    const publisher = new CaptionPublisher({ transport: () => fake, senderIdentity: "p" });
    publisher.offer(update("s1", "mumble"));
    publisher.offer(update("s1", "", true));
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ segmentId: "s1", text: "", isFinal: true }));
  });

  it("stops accepting on close and gives what was offered a bounded time to go out", async () => {
    const { fake, sent, stall } = transport();
    const publisher = new CaptionPublisher({ transport: () => fake, senderIdentity: "p" });
    stall();
    publisher.offer(update("s1", "held forever"));
    const started = Date.now();
    await publisher.close(30);
    expect(Date.now() - started).toBeLessThan(1_000);
    publisher.offer(update("s2", "too late"));
    expect(sent).toEqual([]);
    expect(fake.streamText).toHaveBeenCalledOnce();
  });
});

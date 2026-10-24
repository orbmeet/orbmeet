import { describe, expect, it } from "vitest";
import { MAX_CAPTION_TEXT_LENGTH } from "@orbmeet/caption-protocol";
import { ParticipantKind, Track, type Room, type TextStreamReader } from "livekit-client";
import { readBoundedCaption, validateCaptionStream } from "./use-live-transcriptions";

const stream = {
  trackId: "track-1",
  participantIdentity: "speaker-1",
};

function room(): Room {
  const speaker = {
    identity: "speaker-1",
    name: "Ada",
    kind: ParticipantKind.STANDARD,
    getTrackPublication: (source: Track.Source) =>
      source === Track.Source.Microphone ? { trackSid: "track-1" } : undefined,
  };
  const otherParticipant = {
    identity: "someone-else",
    name: "Mallory",
    kind: ParticipantKind.STANDARD,
    getTrackPublication: () => undefined,
  };
  return {
    localParticipant: {
      identity: "local",
      name: "Local participant",
      kind: ParticipantKind.STANDARD,
      getTrackPublication: () => undefined,
    },
    remoteParticipants: new Map([
      ["speaker-1", speaker],
      ["someone-else", otherParticipant],
    ]),
  } as unknown as Room;
}

describe("validateCaptionStream", () => {
  it("resolves a sender captioning their own microphone", () => {
    expect(validateCaptionStream(room(), stream)).toMatchObject({
      speaker: { identity: "speaker-1" },
    });
  });

  it("rejects a sender naming someone else's microphone", () => {
    expect(
      validateCaptionStream(room(), {
        ...stream,
        participantIdentity: "someone-else",
      }),
    ).toBeNull();
  });

  it("rejects a track that is not owned by the sender", () => {
    expect(validateCaptionStream(room(), {
      ...stream,
      trackId: "track-2",
    })).toBeNull();
  });

  it("accepts an interrupted final from the speaker's retired microphone track", () => {
    expect(validateCaptionStream(room(), {
      ...stream,
      trackId: "retired-track",
      isFinal: true,
    })).toMatchObject({ speaker: { identity: "speaker-1" } });
  });
});

describe("readBoundedCaption", () => {
  function reader(chunks: string[], size?: number): TextStreamReader {
    let read = 0;
    return {
      info: { size },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          read += 1;
          yield chunk;
        }
      },
      get chunksRead() {
        return read;
      },
    } as unknown as TextStreamReader;
  }

  it("joins a stream's chunks into one trimmed caption", async () => {
    await expect(readBoundedCaption(reader([" Hello ", "world "]))).resolves.toBe("Hello world");
  });

  it("reads an empty caption as empty: a final with no text withdraws its segment", async () => {
    await expect(readBoundedCaption(reader(["  "]))).resolves.toBe("");
  });

  it("refuses a declared size beyond a caption without reading it", async () => {
    const oversized = reader(["x"], MAX_CAPTION_TEXT_LENGTH * 3 + 1);
    await expect(readBoundedCaption(oversized)).resolves.toBeNull();
    expect((oversized as unknown as { chunksRead: number }).chunksRead).toBe(0);
  });

  it("stops reading once an undeclared stream outgrows a caption", async () => {
    const endless = reader(["x".repeat(MAX_CAPTION_TEXT_LENGTH), "y", "never read"]);
    await expect(readBoundedCaption(endless)).resolves.toBeNull();
    expect((endless as unknown as { chunksRead: number }).chunksRead).toBe(2);
  });
});

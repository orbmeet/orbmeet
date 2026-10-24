// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CAPTION_TOPIC, encodeCaptionStreamAttributes } from "@orbmeet/caption-protocol";
import { ParticipantKind, Track, type Room, type TextStreamReader } from "livekit-client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CaptionTranscriptEntry } from "./board";
import { useLiveTranscriptions } from "./use-live-transcriptions";

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

type Handler = (reader: TextStreamReader, participant: { identity: string }) => void;

function fakeRoom() {
  const room = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let handler: Handler | null = null;
  const speaker = {
    identity: "speaker-1",
    name: "Ada",
    kind: ParticipantKind.STANDARD,
    getTrackPublication: (source: Track.Source) =>
      source === Track.Source.Microphone ? { trackSid: "TR_mic" } : undefined,
  };
  Object.assign(room, {
    localParticipant: { identity: "local", getTrackPublication: () => undefined },
    remoteParticipants: new Map([[speaker.identity, speaker]]),
    registerTextStreamHandler: (topic: string, next: Handler) => {
      expect(topic).toBe(CAPTION_TOPIC);
      handler = next;
    },
    unregisterTextStreamHandler: () => {
      handler = null;
    },
  });
  return {
    room: room as unknown as Room,
    send(caption: { segmentId: string; revision: number; isFinal: boolean; text: string }) {
      const reader = {
        info: {
          attributes: encodeCaptionStreamAttributes({
            trackId: "TR_mic",
            segmentId: caption.segmentId,
            isFinal: caption.isFinal,
            revision: caption.revision,
          }),
        },
        async *[Symbol.asyncIterator]() {
          if (caption.text) yield caption.text;
        },
      } as unknown as TextStreamReader;
      handler?.(reader, { identity: "speaker-1" });
    },
  };
}

function watch(room: Room) {
  let latest: readonly CaptionTranscriptEntry[] = [];
  function Probe() {
    latest = useLiveTranscriptions({ room });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Probe />));
  return () => latest;
}

async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

describe("useLiveTranscriptions", () => {
  it("shows a segment as it grows and finalizes", async () => {
    const { room, send } = fakeRoom();
    const captions = watch(room);
    send({ segmentId: "job:u0", revision: 1, isFinal: false, text: "hel" });
    await flush();
    send({ segmentId: "job:u0", revision: 2, isFinal: true, text: "hello" });
    await flush();

    expect(captions()).toEqual([
      expect.objectContaining({ id: "job:u0", userName: "Ada", text: "hello", isFinal: true }),
    ]);
  });

  it("removes a segment the agent withdraws", async () => {
    const { room, send } = fakeRoom();
    const captions = watch(room);
    send({ segmentId: "job:u0", revision: 1, isFinal: false, text: "mumble" });
    await flush();
    send({ segmentId: "job:u0", revision: 2, isFinal: true, text: "" });
    await flush();
    expect(captions()).toEqual([]);
  });

  it("still takes a final after a burst of interims the interim budget refused", async () => {
    const { room, send } = fakeRoom();
    const captions = watch(room);
    for (let revision = 1; revision <= 80; revision += 1) {
      send({ segmentId: "job:u0", revision, isFinal: false, text: `word ${revision}` });
    }
    send({ segmentId: "job:u1", revision: 1, isFinal: true, text: "the final" });
    await flush();

    expect(captions().map((entry) => entry.text)).toContain("the final");
  });
});

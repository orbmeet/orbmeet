import { describe, expect, it } from "vitest";
import {
  MAX_TRANSCRIPT_ENTRIES,
  OPEN_SEGMENT_SILENCE_MS,
  emptyCaptionBoard,
  nextCaptionExpiry,
  reduceCaptionBoard,
  type CaptionBoardState,
  type CaptionUpdate,
} from "./board";

function update(overrides: Partial<CaptionUpdate> = {}): CaptionUpdate {
  return {
    segmentId: "job:u0",
    revision: 1,
    participant: "user-1",
    userName: "Ada",
    text: "hello",
    isFinal: false,
    receivedAt: 1_000,
    ...overrides,
  };
}

/** An entry's key: its speaker's segment. */
const key = (segmentId: string, participant = "user-1") => `${participant}\u0000${segmentId}`;

function apply(...updates: CaptionUpdate[]): CaptionBoardState {
  return updates.reduce(
    (state, next) => reduceCaptionBoard(state, { type: "caption", update: next }),
    emptyCaptionBoard(),
  );
}

describe("reduceCaptionBoard", () => {
  it("grows one entry in place as its segment is revised, then freezes it", () => {
    const state = apply(
      update({ revision: 1, text: "hel", receivedAt: 1_000 }),
      update({ revision: 2, text: "hello there", receivedAt: 1_400 }),
      update({ revision: 3, text: "hello there.", isFinal: true, receivedAt: 1_900 }),
    );
    // It keeps its place in time from the first word, and its last update.
    expect(state.transcript).toEqual([
      { id: key("job:u0"), participant: "user-1", userName: "Ada", text: "hello there.", isFinal: true, startedAt: 1_000, updatedAt: 1_900 },
    ]);
  });

  it("ignores an update older than the one it has", () => {
    const state = apply(update({ revision: 2, text: "newer" }), update({ revision: 1, text: "older" }));
    expect(state.transcript[0].text).toBe("newer");
  });

  it("does not reopen a finalized segment", () => {
    const state = apply(
      update({ revision: 2, text: "done", isFinal: true }),
      update({ revision: 3, text: "reopened" }),
    );
    expect(state.transcript[0]).toMatchObject({ text: "done", isFinal: true });
  });

  it("keeps separate utterances separate, even when one never finalized", () => {
    // Utterance A's final was lost; B must not overwrite what A showed.
    const state = apply(
      update({ segmentId: "job:u0", text: "first thought" }),
      update({ segmentId: "job:u1", text: "second thought", isFinal: true }),
    );
    expect(state.transcript.map((entry) => [entry.id, entry.text])).toEqual([
      [key("job:u0"), "first thought"],
      [key("job:u1"), "second thought"],
    ]);
  });

  it("keeps each speaker's segments their own, whatever id another sends", () => {
    // Bob's client sends Ada's segment id, final and far ahead: it is Bob's
    // own segment, and Ada's line stands.
    const state = apply(
      update({ segmentId: "job:u0", participant: "ada", text: "the answer is four", revision: 1 }),
      update({ segmentId: "job:u0", participant: "bob", text: "", revision: 99, isFinal: true }),
      update({ segmentId: "job:u0", participant: "ada", text: "the answer is four.", revision: 2, isFinal: true }),
    );
    expect(state.transcript).toEqual([
      expect.objectContaining({ id: key("job:u0", "ada"), participant: "ada", text: "the answer is four.", isFinal: true }),
    ]);
  });

  it("keeps interleaved speakers in the order they started", () => {
    const state = apply(
      update({ segmentId: "a:u0", participant: "a", text: "a starts" }),
      update({ segmentId: "b:u0", participant: "b", text: "b starts" }),
      update({ segmentId: "a:u0", participant: "a", revision: 2, text: "a starts and finishes", isFinal: true }),
    );
    expect(state.transcript.map((entry) => entry.id)).toEqual([key("a:u0", "a"), key("b:u0", "b")]);
    expect(state.transcript[0].text).toBe("a starts and finishes");
  });

  it("removes a segment withdrawn by an empty final, and remembers it was withdrawn", () => {
    let state = apply(update({ text: "mumble" }), update({ revision: 2, text: "", isFinal: true }));
    expect(state.transcript).toEqual([]);
    state = reduceCaptionBoard(state, { type: "caption", update: update({ revision: 1, text: "mumble" }) });
    expect(state.transcript).toEqual([]);
  });

  it("closes a segment that went quiet without a final, as it stood", () => {
    const state = apply(update({ text: "cut off", receivedAt: 1_000 }));
    expect(nextCaptionExpiry(state)).toBe(1_000 + OPEN_SEGMENT_SILENCE_MS);
    expect(reduceCaptionBoard(state, { type: "expire", now: 1_500 })).toBe(state);

    const closed = reduceCaptionBoard(state, { type: "expire", now: 1_000 + OPEN_SEGMENT_SILENCE_MS });
    expect(closed.transcript[0]).toMatchObject({ text: "cut off", isFinal: true });
    expect(nextCaptionExpiry(closed)).toBeNull();
    // A straggler cannot reopen what the board closed.
    const straggler = reduceCaptionBoard(closed, { type: "caption", update: update({ revision: 2, text: "cut off late" }) });
    expect(straggler.transcript[0].text).toBe("cut off");
  });

  it("caps the scrollback, dropping the oldest entries", () => {
    let state = emptyCaptionBoard();
    for (let index = 0; index < MAX_TRANSCRIPT_ENTRIES + 5; index += 1) {
      state = reduceCaptionBoard(state, {
        type: "caption",
        update: update({ segmentId: `job:u${index}`, text: `line ${index}`, isFinal: true }),
      });
    }
    expect(state.transcript).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(state.transcript[0].id).toBe(key("job:u5"));
  });

  it("keeps its segment records bounded however many segments are withdrawn", () => {
    let state = emptyCaptionBoard();
    for (let index = 0; index < MAX_TRANSCRIPT_ENTRIES * 5; index += 1) {
      state = reduceCaptionBoard(state, {
        type: "caption",
        update: update({ segmentId: `job:u${index}`, text: "", isFinal: true }),
      });
    }
    expect(state.segments.size).toBeLessThanOrEqual(MAX_TRANSCRIPT_ENTRIES * 2);
  });

  it("drops everything when the viewer leaves", () => {
    const cleared = reduceCaptionBoard(apply(update()), { type: "clear" });
    expect(cleared).toEqual(emptyCaptionBoard());
    expect(reduceCaptionBoard(cleared, { type: "clear" })).toBe(cleared);
  });
});

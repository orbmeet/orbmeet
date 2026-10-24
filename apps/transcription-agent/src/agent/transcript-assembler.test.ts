import { MAX_CAPTION_TEXT_LENGTH } from "@orbmeet/caption-protocol";
import { describe, expect, it } from "vitest";
import {
  initialAssemblerState,
  reduceTranscript,
  splitCaptionText,
  type AssemblerState,
  type CaptionUpdate,
  type TranscriptEvent,
  type TranscriptFinal,
} from "./transcript-assembler.js";

type Words = Extract<TranscriptEvent, { kind: "words" }>;

function words(text: string, overrides: Partial<Words> = {}): Words {
  return {
    kind: "words",
    text,
    isFinal: false,
    endpoint: false,
    fromFinalize: false,
    startedAt: 1_000,
    endedAt: 2_000,
    trackSid: "TR_mic",
    language: "en-US",
    receivedAt: 9_000,
    ...overrides,
  };
}

function run(events: TranscriptEvent[], state: AssemblerState = initialAssemblerState()) {
  const finals: TranscriptFinal[] = [];
  const captions: CaptionUpdate[] = [];
  for (const event of events) {
    const step = reduceTranscript(state, event, "job-1");
    state = step.state;
    finals.push(...step.finals);
    captions.push(...step.captions);
  }
  return { state, finals, captions };
}

describe("reduceTranscript", () => {
  it("journals each committed chunk once and captions the utterance as one growing segment", () => {
    const { finals, captions, state } = run([
      words("hello"),
      words("hello there", { isFinal: true, startedAt: 1_000 }),
      words("general"),
      words("general kenobi", { isFinal: true, endpoint: true, startedAt: 2_500 }),
    ]);

    expect(finals).toEqual([
      { segmentId: "job-1:u0:f0", text: "hello there", startedAt: 1_000, language: "en-US" },
      { segmentId: "job-1:u0:f1", text: "general kenobi", startedAt: 2_500, language: "en-US" },
    ]);
    expect(captions.map(({ segmentId, text, isFinal }) => ({ segmentId, text, isFinal }))).toEqual([
      { segmentId: "job-1:u0", text: "hello", isFinal: false },
      { segmentId: "job-1:u0", text: "hello there", isFinal: false },
      { segmentId: "job-1:u0", text: "hello there general", isFinal: false },
      { segmentId: "job-1:u0", text: "hello there general kenobi", isFinal: true },
    ]);
    expect(state.open).toBeNull();
  });

  it("starts a new segment for the next utterance", () => {
    const { captions } = run([
      words("one", { isFinal: true, endpoint: true }),
      words("two", { isFinal: true, endpoint: true }),
    ]);
    expect(captions.map((caption) => caption.segmentId)).toEqual(["job-1:u0", "job-1:u1"]);
  });

  it("closes on a wordless endpoint after the text was committed", () => {
    const { captions, state } = run([
      words("committed", { isFinal: true }),
      words("", { endpoint: true }),
    ]);
    expect(captions.at(-1)).toMatchObject({ text: "committed", isFinal: true });
    expect(state.open).toBeNull();
  });

  it("remembers an endpoint flagged on a hypothesis until the final commits it", () => {
    const { finals, captions, state } = run([
      words("endpoint candidate", { endpoint: true }),
      words("endpoint candidate", { isFinal: true }),
    ]);
    expect(finals).toHaveLength(1);
    expect(captions.at(-1)).toMatchObject({ text: "endpoint candidate", isFinal: true });
    expect(state.open).toBeNull();
  });

  it("closes on Deepgram's answer to Finalize and on its word-gap boundary", () => {
    expect(run([words("muted", { isFinal: true, fromFinalize: true })]).state.open).toBeNull();
    const gap = run([words("paused", { isFinal: true }), { kind: "utterance-end" }]);
    expect(gap.state.open).toBeNull();
    expect(gap.captions.at(-1)).toMatchObject({ text: "paused", isFinal: true });
  });

  it("closes an utterance that has run past its time limit", () => {
    const { state } = run([
      words("a long speech", { isFinal: true, startedAt: 0, endedAt: 30_000 }),
    ]);
    expect(state.open).toBeNull();
  });

  it("keeps what the room saw when the utterance is interrupted", () => {
    const { finals, captions } = run([
      words("said", { isFinal: true }),
      words("and then"),
      { kind: "interrupt" },
    ]);
    expect(finals.map((final) => final.text)).toEqual(["said"]);
    expect(captions.at(-1)).toMatchObject({ text: "said and then", isFinal: true });
  });

  it("withdraws a segment whose hypothesis Deepgram did not commit", () => {
    const { finals, captions } = run([
      words("mumble"),
      words("", { isFinal: true, endpoint: true }),
    ]);
    expect(finals).toEqual([]);
    expect(captions.at(-1)).toMatchObject({ segmentId: "job-1:u0", text: "", isFinal: true });
  });

  it("stamps finals with capture time, falling back to arrival only when the audio cannot be placed", () => {
    const { finals } = run([
      words("placed", { isFinal: true, startedAt: 1_234 }),
      words("unplaced", { isFinal: true, startedAt: null }),
    ]);
    expect(finals.map((final) => final.startedAt)).toEqual([1_234, 9_000]);
  });

  it("journals a final even when no track is known to caption it under", () => {
    const { finals, captions } = run([words("orphan", { isFinal: true, trackSid: null })]);
    expect(finals.map((final) => final.text)).toEqual(["orphan"]);
    expect(captions).toEqual([]);
  });

  it("names the track the utterance's audio came from", () => {
    const { captions } = run([
      words("old mic", { isFinal: true, endpoint: true, trackSid: "TR_old" }),
      words("new mic", { isFinal: true, endpoint: true, trackSid: "TR_new" }),
    ]);
    expect(captions.map((caption) => caption.trackSid)).toEqual(["TR_old", "TR_new"]);
  });

  it("continues an oversized utterance in a new caption part without losing words", () => {
    const sentence = "word ".repeat(Math.ceil((MAX_CAPTION_TEXT_LENGTH * 1.5) / 5)).trim();
    const { finals, captions } = run([words(sentence, { isFinal: true, endpoint: true })]);

    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe(sentence);
    const closed = captions.filter((caption) => caption.isFinal);
    expect(closed.map((caption) => caption.segmentId)).toEqual(["job-1:u0", "job-1:u0.1"]);
    expect(closed.every((caption) => caption.text.length <= MAX_CAPTION_TEXT_LENGTH)).toBe(true);
    expect(closed.map((caption) => caption.text).join(" ")).toBe(sentence);
  });
});

describe("splitCaptionText", () => {
  it("never cuts a surrogate pair", () => {
    const text = `${"a".repeat(MAX_CAPTION_TEXT_LENGTH - 1)}😀tail`;
    const { head, tail } = splitCaptionText(text);
    expect(head.length).toBeLessThanOrEqual(MAX_CAPTION_TEXT_LENGTH);
    expect(`${head}${tail}`).toBe(text);
  });
});

describe("reduceTranscript over generated Deepgram sessions", () => {
  // A small deterministic generator: the same seed always yields the same session.
  function random(seed: number) {
    let value = seed;
    return () => {
      value = (value * 1_103_515_245 + 12_345) % 2_147_483_648;
      return value / 2_147_483_648;
    };
  }

  function session(seed: number): TranscriptEvent[] {
    const next = random(seed);
    const events: TranscriptEvent[] = [];
    for (let index = 0; index < 200; index += 1) {
      const roll = next();
      const text = next() < 0.2 ? "" : `w${index}`;
      if (roll < 0.05) events.push({ kind: "interrupt" });
      else if (roll < 0.1) events.push({ kind: "utterance-end" });
      else {
        events.push(words(text, {
          isFinal: next() < 0.4,
          endpoint: next() < 0.15,
          fromFinalize: next() < 0.05,
          trackSid: next() < 0.5 ? "TR_a" : "TR_b",
          startedAt: index,
          endedAt: index + 1,
        }));
      }
    }
    events.push({ kind: "interrupt" });
    return events;
  }

  for (const seed of [1, 7, 42, 1_234, 99_999]) {
    it(`holds the record and caption invariants for seed ${seed}`, () => {
      const events = session(seed);
      const { finals, captions, state } = run(events);

      // Every committed text is journaled exactly once, with a unique id.
      const committed = events.flatMap((event) =>
        event.kind === "words" && event.isFinal && event.text.trim() ? [event.text.trim()] : []);
      expect(finals.map((final) => final.text)).toEqual(committed);
      expect(new Set(finals.map((final) => final.segmentId)).size).toBe(finals.length);

      // Every caption segment that was opened was closed, and nothing follows its close.
      const closedAt = new Map<string, number>();
      captions.forEach((caption, index) => {
        expect(closedAt.has(caption.segmentId)).toBe(false);
        if (caption.isFinal) closedAt.set(caption.segmentId, index);
      });
      for (const caption of captions) expect(closedAt.has(caption.segmentId)).toBe(true);
      expect(state.open).toBeNull();
    });
  }
});

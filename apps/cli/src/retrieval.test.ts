import { describe, expect, it } from "vitest";

import type { ApiRequest } from "./api.ts";
import type { ParsedArgs } from "./args.ts";
import { parseTranscriptLimit, retrieveMeeting } from "./retrieval.ts";

function makeArgs(meetingId = "meeting_x"): ParsedArgs {
  return { positional: ["transcript"], options: new Map([["meeting-id", meetingId]]) };
}

function fakeRequest(responses: unknown[]): { calls: string[]; request: ApiRequest } {
  const calls: string[] = [];
  return {
    calls,
    request: async (path) => {
      calls.push(path);
      const next = responses.shift();
      if (!next) throw new Error("Unexpected extra request");
      return next;
    },
  };
}

// Envelope fixtures satisfy the shared public API schemas the way the server
// emits them; the CLI parses every payload against those schemas now.
function segment(text: string) {
  return {
    participantName: "Ana",
    text,
    language: null,
    startedAt: "2026-07-21T14:00:00.000Z",
  };
}

function envelope(transcript: unknown) {
  return {
    data: {
      meeting: {
        id: "meeting_x",
        title: "Standup",
        startedAt: "2026-07-21T14:00:00.000Z",
        endedAt: null,
        retainUntil: null,
        spaceName: null,
        participants: [],
      },
      available: {
        summary: false,
        transcript: true,
        recordings: false,
        whiteboardPdf: false,
      },
      transcript,
    },
  };
}

describe("retrieveMeeting", () => {
  it("returns the first page untouched when there is no transcript cursor", async () => {
    const initial = envelope({ segments: [segment("a")], nextCursor: null });
    const { request, calls } = fakeRequest([initial]);
    const result = await retrieveMeeting(request, makeArgs(), ["transcript"]);
    expect(result.raw).toBe(initial);
    expect(result.data.transcript).toEqual({
      segments: [segment("a")],
      nextCursor: null,
    });
    expect(calls).toEqual(["/api/v1/meetings/?meetingId=meeting_x&include=transcript"]);
  });

  it("does not paginate when transcript was not requested", async () => {
    const initial = {
      data: {
        meeting: {
          id: "meeting_x",
          title: null,
          startedAt: "2026-07-21T14:00:00.000Z",
          endedAt: null,
          retainUntil: null,
          spaceName: null,
          participants: [],
        },
        available: {
          summary: true,
          transcript: false,
          recordings: false,
          whiteboardPdf: false,
        },
        summary: "hi",
      },
    };
    const { request, calls } = fakeRequest([initial]);
    await retrieveMeeting(request, makeArgs(), ["summary"]);
    expect(calls).toHaveLength(1);
  });

  it("rejects a malformed transcript payload with a stable API error", async () => {
    const { request } = fakeRequest([envelope({ nextCursor: null })]);
    await expect(retrieveMeeting(request, makeArgs(), ["transcript"]))
      .rejects.toThrow("invalid transcript response");
  });

  it("rejects malformed continuation envelopes with a stable API error", async () => {
    const { request } = fakeRequest([
      envelope({ segments: [segment("a")], nextCursor: { startedAt: 1, id: "s1" } }),
      { data: null },
    ]);
    await expect(retrieveMeeting(request, makeArgs(), ["transcript"]))
      .rejects.toThrow("invalid transcript page");
  });

  it("follows transcript cursors and merges all segments", async () => {
    const { request, calls } = fakeRequest([
      envelope({ segments: [segment("a")], nextCursor: { startedAt: 1, id: "s1" } }),
      { data: { transcript: { segments: [segment("b")], nextCursor: { startedAt: 2, id: "s2" } } } },
      { data: { transcript: { segments: [segment("c")], nextCursor: null } } },
    ]);
    const result = await retrieveMeeting(request, makeArgs(), ["transcript"]);
    expect(result.data.transcript).toEqual({
      segments: [segment("a"), segment("b"), segment("c")],
      nextCursor: null,
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("cursorStartedAt=1");
    expect(calls[1]).toContain("cursorId=s1");
  });

  it("preserves initial response metadata in paginated raw output", async () => {
    const { request } = fakeRequest([
      {
        requestId: "request-1",
        data: {
          ...envelope({ segments: [segment("a")], nextCursor: { startedAt: 1, id: "s1" } }).data,
        },
      },
      { data: { transcript: { segments: [segment("b")], nextCursor: null } } },
    ]);

    const result = await retrieveMeeting(request, makeArgs(), ["transcript"]);
    expect(result.raw).toMatchObject({
      requestId: "request-1",
      data: { transcript: { segments: [segment("a"), segment("b")] } },
    });
  });

  it("stops paginating at the transcript limit and flags truncation", async () => {
    const { request, calls } = fakeRequest([
      envelope({
        segments: [segment("a"), segment("b")],
        nextCursor: { startedAt: 2, id: "s2" },
      }),
      { data: { transcript: { segments: [segment("c")], nextCursor: { startedAt: 3, id: "s3" } } } },
    ]);
    const result = await retrieveMeeting(request, makeArgs(), ["transcript"], 3);
    expect(result.data.transcript).toEqual({
      segments: [segment("a"), segment("b"), segment("c")],
      nextCursor: null,
      truncated: true,
    });
    expect(calls[0]).toContain("transcriptLimit=3");
    expect(calls[1]).toContain("transcriptLimit=1");
    expect(calls).toHaveLength(2);
  });

  it("flags truncation when the cap is hit on the first page", async () => {
    const { request, calls } = fakeRequest([
      envelope({ segments: [segment("a")], nextCursor: { startedAt: 1, id: "s1" } }),
    ]);
    const result = await retrieveMeeting(request, makeArgs(), ["transcript"], 1);
    expect(result.data.transcript!.truncated).toBe(true);
    expect(result.data.transcript!.segments).toEqual([segment("a")]);
    expect(calls).toHaveLength(1);
  });

  it("does not flag truncation when everything fit under the cap", async () => {
    const initial = envelope({ segments: [segment("a")], nextCursor: null });
    const { request } = fakeRequest([initial]);
    const result = await retrieveMeeting(request, makeArgs(), ["transcript"], 10);
    expect(result.raw).toBe(initial);
    expect(result.data.transcript!.truncated).toBeUndefined();
  });

  it("aborts when the server returns a non-advancing cursor", async () => {
    const stuck = { startedAt: 1, id: "s1" };
    const { request } = fakeRequest([
      envelope({ segments: [segment("a")], nextCursor: stuck }),
      { data: { transcript: { segments: [], nextCursor: { ...stuck } } } },
    ]);
    await expect(retrieveMeeting(request, makeArgs(), ["transcript"]))
      .rejects.toThrow("cursor cycle");
  });

  it("aborts when pagination cycles through more than one cursor", async () => {
    const first = { startedAt: 1, id: "s1" };
    const second = { startedAt: 2, id: "s2" };
    const { request, calls } = fakeRequest([
      envelope({ segments: [segment("a")], nextCursor: first }),
      { data: { transcript: { segments: [segment("b")], nextCursor: second } } },
      { data: { transcript: { segments: [segment("c")], nextCursor: first } } },
    ]);

    await expect(retrieveMeeting(request, makeArgs(), ["transcript"]))
      .rejects.toThrow("cursor cycle");
    expect(calls).toHaveLength(3);
  });

  it("aborts a server that hands back a fresh cursor forever", async () => {
    // The exact-cursor cycle guard never fires here, so only the page ceiling
    // stops an unbounded loop that would otherwise buffer segments forever.
    let page = 0;
    const calls: string[] = [];
    const request: ApiRequest = async (path) => {
      calls.push(path);
      page += 1;
      const body = { segments: [segment(`s${page}`)], nextCursor: { startedAt: page, id: `c${page}` } };
      return page === 1 ? envelope(body) : { data: { transcript: body } };
    };

    await expect(retrieveMeeting(request, makeArgs(), ["transcript"]))
      .rejects.toThrow("did not finish within 100 pages");
    // The first page plus 100 continuation pages before the ceiling trips.
    expect(calls).toHaveLength(101);
  });
});

describe("parseTranscriptLimit", () => {
  it("defaults to unlimited", () => {
    expect(parseTranscriptLimit(undefined)).toBe(Infinity);
  });

  it("accepts positive whole numbers and rejects the rest", () => {
    expect(parseTranscriptLimit("25")).toBe(25);
    for (const value of ["0", "-1", "2.5", "abc", ""]) {
      expect(() => parseTranscriptLimit(value)).toThrow("--transcript-limit must be");
    }
  });
});

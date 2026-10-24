import { describe, expect, it } from "vitest";

import { publicRetrievedMeeting, publicSchedule, publicSearchResults } from "./output.ts";

// These fixtures exercise the shaping functions with partial payloads. Since
// retrieval now validates every response against the shared public API
// contract, the shaping functions see schema-typed input; the fixtures still
// check that shaping only depends on the fields it documents.
function fixture<T>(value: unknown): T {
  return value as T;
}

describe("publicSchedule", () => {
  it("shapes a schedule for public output", () => {
    expect(publicSchedule(fixture({
      id: "schedule_x",
      title: "Standup",
      startsAt: "2026-07-20T14:00:00.000Z",
      endsAt: "2026-07-20T14:30:00.000Z",
      timeZone: "America/New_York",
      state: "upcoming",
      spaceName: null,
      organizerName: "Ana",
      attendeeCount: 2,
      attendees: [{ displayName: null, email: "bo@example.com" }],
      code: "abc-defg-hij",
      canManage: true,
    }))).toEqual({
      title: "Standup",
      startsAt: "2026-07-20T14:00:00.000Z",
      endsAt: "2026-07-20T14:30:00.000Z",
      timeZone: "America/New_York",
      state: "upcoming",
      space: undefined,
      organizer: "Ana",
      attendeeCount: 2,
      attendees: [{ name: undefined, email: "bo@example.com" }],
      joinUrl: "https://orbmeet.com/abc-defg-hij",
      canManage: true,
    });
  });

  it("omits the join url without a code", () => {
    expect(publicSchedule(fixture({ title: "X", attendees: [] })).joinUrl).toBeUndefined();
  });
});

describe("publicSearchResults", () => {
  it("maps contacts and spaces without exposing internal ids", () => {
    expect(publicSearchResults(fixture({
      query: "an",
      requiresConfirmation: true,
      candidates: [
        {
          type: "contact",
          id: "contact_x",
          name: "Ana",
          email: "ana@example.com",
          meetingCount: 4,
          lastMetAt: "2026-07-01",
        },
        { type: "space", id: "space_y", name: "Design", memberCount: 7 },
      ],
    }))).toEqual({
      query: "an",
      requiresConfirmation: true,
      candidates: [
        {
          type: "person",
          name: "Ana",
          email: "ana@example.com",
          meetingCount: 4,
          lastMetAt: "2026-07-01",
        },
        { type: "space", name: "Design", memberCount: 7 },
      ],
    });
  });
});

describe("publicRetrievedMeeting", () => {
  const meeting = {
    id: "meeting_x",
    title: "Standup",
    startedAt: "2026-07-20T14:00:00.000Z",
    endedAt: "2026-07-20T14:30:00.000Z",
    spaceName: "Design",
    participants: ["Ana", "Bo"],
  };

  it("includes only the sections present on the payload", () => {
    const shaped = publicRetrievedMeeting(fixture({ meeting, available: ["summary"] }));
    expect(shaped.meeting.id).toBe("meeting_x");
    expect(shaped.meeting.space).toBe("Design");
    expect(shaped.available).toEqual(["summary"]);
    expect(Object.hasOwn(shaped, "summary")).toBe(false);
    expect(Object.hasOwn(shaped, "transcript")).toBe(false);
    expect(Object.hasOwn(shaped, "recordings")).toBe(false);
    expect(Object.hasOwn(shaped, "whiteboardPdf")).toBe(false);
  });

  it("shapes transcript segments and keeps a null whiteboard explicit", () => {
    const shaped = publicRetrievedMeeting(fixture({
      meeting,
      available: [],
      transcript: {
        segments: [{ participantName: "Ana", text: "hi", language: null, startedAt: 1 }],
        nextCursor: null,
      },
      whiteboardPdf: null,
    }));
    expect(shaped.transcript).toEqual([
      { speaker: "Ana", text: "hi", language: undefined, startedAt: 1 },
    ]);
    expect(shaped.whiteboardPdf).toBeNull();
    expect(shaped.transcriptTruncated).toBeUndefined();
  });

  it("flags a truncated transcript", () => {
    const shaped = publicRetrievedMeeting(fixture({
      meeting,
      available: [],
      transcript: { segments: [], nextCursor: null, truncated: true },
    }));
    expect(shaped.transcriptTruncated).toBe(true);
  });

  it("keeps an explicitly unavailable transcript as null", () => {
    const shaped = publicRetrievedMeeting(fixture({
      meeting,
      available: [],
      transcript: null,
    }));
    expect(shaped.transcript).toBeNull();
    expect(shaped.transcriptTruncated).toBeUndefined();
  });
});

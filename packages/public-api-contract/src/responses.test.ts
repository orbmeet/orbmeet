import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  publicApiMeResponseSchema,
  publicApiTargetsResponseSchema,
  publicMeetingResponseSchema,
  publicMeetingTranscriptPageResponseSchema,
  publicScheduleCancelResponseSchema,
  publicScheduleCreateResponseSchema,
  publicScheduleListResponseSchema,
  publicScheduleResponseSchema,
  publicScheduleUpdateResponseSchema,
  publicTranscriptSchema,
} from "./responses";

describe("public account response", () => {
  it("includes the account home time zone", () => {
    expect(v.safeParse(publicApiMeResponseSchema, {
      data: {
        user: {
          name: "A",
          email: "a@example.com",
          plan: "free",
          timeZone: "Asia/Dhaka",
        },
        scopes: ["meetings:read"],
        serverTime: "2026-09-09T00:00:00.000Z",
      },
    }).success).toBe(true);
  });
});

describe("public schedule responses", () => {
  it("accepts the null title returned for untitled schedules", () => {
    expect(v.safeParse(publicScheduleResponseSchema, {
      data: {
        id: "schedule_01example",
        title: null,
        startsAt: "2026-08-22T10:00:00.000Z",
        endsAt: "2026-08-22T10:30:00.000Z",
        timeZone: "Asia/Dhaka",
        state: "upcoming",
        revision: 1,
        code: null,
      },
    }).success).toBe(true);
  });

  it("rejects schedule states the API never emits", () => {
    const schedule = {
      id: "schedule_01example",
      title: null,
      startsAt: "2026-08-22T10:00:00.000Z",
      endsAt: "2026-08-22T10:30:00.000Z",
      timeZone: "Asia/Dhaka",
      state: "scheduled",
      revision: 1,
      code: null,
    };
    expect(v.safeParse(publicScheduleResponseSchema, { data: schedule }).success).toBe(false);
  });

  it("keeps the single-schedule and list envelopes distinct", () => {
    const schedule = {
      id: "schedule_01example",
      title: null,
      startsAt: "2026-08-22T10:00:00.000Z",
      endsAt: "2026-08-22T10:30:00.000Z",
      timeZone: "Asia/Dhaka",
      state: "upcoming",
      revision: 1,
      code: null,
    };
    // GET /api/v1/schedules answers a selector with one schedule and a page
    // query with an array. Parsing one envelope's payload with the other's
    // schema throws at the HTTP boundary, which is a 500, not a validation
    // error — so the two must not be treated as interchangeable.
    expect(v.safeParse(publicScheduleResponseSchema, { data: schedule }).success).toBe(true);
    expect(v.safeParse(publicScheduleListResponseSchema, { data: schedule }).success).toBe(false);
    expect(v.safeParse(publicScheduleListResponseSchema, { data: [schedule] }).success).toBe(true);
    expect(v.safeParse(publicScheduleResponseSchema, { data: [schedule] }).success).toBe(false);
  });

  it("publishes the distinct create, update, and cancel response shapes", () => {
    expect(v.safeParse(publicScheduleCreateResponseSchema, {
      data: {
        id: "schedule_01example",
        meetingLinkId: "link_01example",
        code: "abc-defg-hij",
        revision: 1,
        title: "Planning",
        startsAt: "2026-08-22T10:00:00.000Z",
        endsAt: "2026-08-22T10:30:00.000Z",
        timeZone: "Asia/Dhaka",
        reminderMinutesBefore: null,
        canceledAt: null,
        attendeeCount: 0,
        spaceId: null,
        spaceName: null,
      },
    }).success).toBe(true);
    expect(v.safeParse(publicScheduleUpdateResponseSchema, {
      data: {
        id: "schedule_01example",
        revision: 2,
        startsAt: "2026-08-22T11:00:00.000Z",
        endsAt: "2026-08-22T11:30:00.000Z",
        timeZone: "Asia/Dhaka",
        reminderMinutesBefore: 10,
      },
    }).success).toBe(true);
    expect(v.safeParse(publicScheduleCancelResponseSchema, {
      data: { id: "schedule_01example", revision: 3, alreadyCanceled: false },
    }).success).toBe(true);
  });
});

describe("public meeting responses", () => {
  it("accepts the null title emitted for default-link meetings", () => {
    expect(v.safeParse(publicMeetingResponseSchema, {
      data: {
        meeting: {
          id: "meeting_01example",
          title: null,
          startedAt: "2026-08-22T10:00:00.000Z",
          endedAt: null,
          retainUntil: null,
          spaceName: "Example",
          participants: [],
        },
        available: {
          summary: false,
          transcript: false,
          recordings: false,
          whiteboardPdf: false,
        },
      },
    }).success).toBe(true);
  });
});

describe("public search targets response", () => {
  const query = { query: "ana", requiresConfirmation: false };

  it("distinguishes contact and space candidates and allows email-less contacts", () => {
    const parsed = v.parse(publicApiTargetsResponseSchema, {
      data: {
        ...query,
        candidates: [
          {
            type: "contact",
            id: "contact_01example",
            name: "Ana",
            email: "ana@example.com",
            meetingCount: 4,
            lastMetAt: "2026-07-01T00:00:00.000Z",
          },
          { type: "contact", name: "No Email", meetingCount: 0, lastMetAt: null },
          { type: "space", id: "space_01example", name: "Design", role: "owner", memberCount: 7 },
        ],
      },
    });
    expect(parsed.data.candidates[0]).toMatchObject({ type: "contact", email: "ana@example.com" });
    expect(parsed.data.candidates[1].email).toBeUndefined();
    expect(parsed.data.candidates[2]).toMatchObject({ type: "space", memberCount: 7 });
  });

  it("rejects unknown candidate types and negative counts", () => {
    expect(v.safeParse(publicApiTargetsResponseSchema, {
      data: { ...query, candidates: [{ type: "ghost", name: "x" }] },
    }).success).toBe(false);
    expect(v.safeParse(publicApiTargetsResponseSchema, {
      data: { ...query, candidates: [{ type: "space", name: "x", memberCount: -1 }] },
    }).success).toBe(false);
    expect(v.safeParse(publicApiTargetsResponseSchema, {
      data: { ...query, candidates: [{ type: "contact", name: "x", meetingCount: 1.5, lastMetAt: null }] },
    }).success).toBe(false);
  });
});

describe("public schedule enrichment fields", () => {
  const base = {
    id: "schedule_01example",
    title: "Planning",
    startsAt: "2026-08-22T10:00:00.000Z",
    endsAt: "2026-08-22T10:30:00.000Z",
    timeZone: "Asia/Dhaka",
    state: "upcoming",
    revision: 1,
    code: "abc-defg-hij",
  };

  it("accepts the enrichment fields the list and detail endpoints emit", () => {
    expect(v.safeParse(publicScheduleResponseSchema, {
      data: {
        ...base,
        spaceName: "Design",
        organizerName: "Ana",
        attendeeCount: 2,
        attendees: [{ email: "bo@example.com", displayName: null }],
        canManage: true,
      },
    }).success).toBe(true);
  });

  it("still accepts the minimal schedule shape", () => {
    expect(v.safeParse(publicScheduleResponseSchema, { data: base }).success).toBe(true);
  });
});

describe("public transcript payloads", () => {
  it("accepts server segments with extra columns and a cursor", () => {
    const parsed = v.parse(publicMeetingTranscriptPageResponseSchema, {
      data: {
        transcript: {
          segments: [{
            id: "tx_01example",
            participantIdentity: "participant",
            participantName: "Ana",
            text: "hello",
            language: null,
            startedAt: "2026-08-22T10:00:00.000Z",
            updatedAt: "2026-08-22T10:00:05.000Z",
          }],
          nextCursor: { startedAt: 10, id: "tx_01example" },
        },
      },
    });
    expect(parsed.data.transcript.segments[0].participantName).toBe("Ana");
    expect(parsed.data.transcript.nextCursor).toEqual({ startedAt: 10, id: "tx_01example" });
  });

  it("requires a speaker and an instant on every segment", () => {
    expect(v.safeParse(publicTranscriptSchema, { segments: [{ text: "hi" }] }).success).toBe(false);
    expect(v.safeParse(publicTranscriptSchema, {
      segments: [{ participantName: "Ana", startedAt: "2026-08-22T10:00:00.000Z" }],
    }).success).toBe(false);
  });
});

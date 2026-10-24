import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  automationMeetingLookupSchema,
  automationScheduleSelectorSchema,
  createAutomationMeetingScheduleSchema,
  searchAutomationTargetsSchema,
} from "./index";

describe("automation schemas", () => {
  it("accepts human-facing schedule selectors in an explicit time zone", () => {
    expect(v.parse(automationScheduleSelectorSchema, {
      date: "2026-07-18",
      timeZone: "Asia/Dhaka",
      title: "product sync",
      participant: "Aariz",
    })).toMatchObject({ date: "2026-07-18", participant: "Aariz" });
  });

  it("requires a selector and rejects invalid local-date context", () => {
    expect(v.safeParse(automationScheduleSelectorSchema, {
      timeZone: "Asia/Dhaka",
    }).success).toBe(false);
    expect(v.safeParse(automationScheduleSelectorSchema, {
      date: "July 18",
      timeZone: "not/a-zone",
    }).success).toBe(false);
    expect(v.safeParse(automationScheduleSelectorSchema, {
      date: "2026-02-31",
      timeZone: "Asia/Dhaka",
    }).success).toBe(false);
  });

  it("accepts names for contacts and Spaces as mutually exclusive targets", () => {
    const base = {
      startsAt: "2026-07-18T10:00:00.000Z",
      durationMinutes: 30,
      timeZone: "Asia/Dhaka",
      attendees: [],
    };
    expect(v.safeParse(createAutomationMeetingScheduleSchema, {
      ...base,
      contactNames: ["Aariz"],
      spaceName: "Product",
    }).success).toBe(false);
    expect(v.parse(createAutomationMeetingScheduleSchema, {
      ...base,
      spaceName: "Product",
    })).toMatchObject({ spaceName: "Product" });
    expect(v.safeParse(createAutomationMeetingScheduleSchema, {
      ...base,
      spaceId: "space_01example",
      spaceName: "Product",
    }).success).toBe(false);
  });

  it("supports human Meeting lookups and internal cursor continuation", () => {
    expect(v.safeParse(automationMeetingLookupSchema, {
      date: "2026-07-18",
      timeZone: "Asia/Dhaka",
      participant: "Aariz",
      include: ["summary", "transcript"],
    }).success).toBe(true);
    expect(v.safeParse(automationMeetingLookupSchema, {
      meetingId: "meeting_01example",
      include: ["transcript"],
      transcriptCursor: { startedAt: 1_752_828_400_000, id: "transcript_01example" },
    }).success).toBe(true);
    expect(v.safeParse(automationMeetingLookupSchema, {
      title: "Product sync",
      include: [],
    }).success).toBe(false);
  });

  it("rejects selectors that exceed D1's escaped UTF-8 LIKE limit", () => {
    expect(v.safeParse(searchAutomationTargetsSchema, {
      query: "a".repeat(48),
    }).success).toBe(true);
    expect(v.safeParse(searchAutomationTargetsSchema, {
      query: "a".repeat(49),
    }).success).toBe(false);
    expect(v.safeParse(automationScheduleSelectorSchema, {
      timeZone: "Asia/Dhaka",
      title: "%".repeat(25),
    }).success).toBe(false);
    expect(v.safeParse(automationMeetingLookupSchema, {
      timeZone: "Asia/Dhaka",
      participant: "界".repeat(17),
    }).success).toBe(false);

    const schedule = {
      startsAt: "2026-07-18T10:00:00.000Z",
      durationMinutes: 30,
      timeZone: "Asia/Dhaka",
      contactNames: ["a".repeat(49)],
    };
    expect(v.safeParse(createAutomationMeetingScheduleSchema, schedule).success).toBe(false);
  });

  it.each([
    [searchAutomationTargetsSchema, { query: "Aariz" }],
    [automationScheduleSelectorSchema, { timeZone: "Asia/Dhaka", title: "sync" }],
    [automationMeetingLookupSchema, { meetingId: "meeting_01example" }],
  ])("strips unknown v1 automation input fields", (schema, input) => {
    expect(v.parse(schema, { ...input, unexpected: true })).not.toHaveProperty("unexpected");
  });

  it("strips unknown fields inside transcript cursors", () => {
    const result = v.parse(automationMeetingLookupSchema, {
      meetingId: "meeting_01example",
      transcriptCursor: {
        startedAt: 1_752_828_400_000,
        id: "transcript_01example",
        unexpected: true,
      },
    });
    expect(result.transcriptCursor).not.toHaveProperty("unexpected");
  });
});

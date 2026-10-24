import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  cancelMeetingScheduleSchema,
  createAutomationMeetingScheduleSchema,
  createMeetingScheduleSchema,
  getMeetingScheduleSchema,
  rescheduleMeetingSchema,
} from "./scheduling";

const schedule = {
  startsAt: "2026-05-20T10:00:00Z",
  durationMinutes: 30,
  timeZone: "America/New_York",
  attendees: [],
};

describe("meeting schedule timestamps", () => {
  it.each([
    "2026-05-20T10:00:00Z",
    "2026-05-20T10:00:00.000Z",
    "2026-05-20T10:00:00-04:00",
  ])("accepts an unambiguous instant: %s", (startsAt) => {
    expect(v.safeParse(createMeetingScheduleSchema, { ...schedule, startsAt }).success)
      .toBe(true);
  });

  it("keeps accepting v1 offset-less values but normalizes them to UTC", () => {
    expect(v.parse(createMeetingScheduleSchema, {
      ...schedule,
      startsAt: "2026-05-20T10:00:00",
    }).startsAt).toBe("2026-05-20T10:00:00Z");
    expect(v.parse(rescheduleMeetingSchema, {
      scheduleId: "schedule_1",
      expectedRevision: 1,
      ...schedule,
      startsAt: "2026-05-20T10:00:00",
    }).startsAt).toBe("2026-05-20T10:00:00Z");
  });

  it.each([
    "2026-05-20",
    "Wed, 20 May 2026 10:00:00 GMT",
  ])("retains the legacy v1 parseable timestamp surface: %s", (startsAt) => {
    expect(v.safeParse(createMeetingScheduleSchema, { ...schedule, startsAt }).success)
      .toBe(true);
  });
});

describe("meeting schedule mutation boundaries", () => {
  it.each([
    ["get", getMeetingScheduleSchema, { scheduleId: "schedule_1" }],
    [
      "cancel",
      cancelMeetingScheduleSchema,
      { scheduleId: "schedule_1", expectedRevision: 1 },
    ],
    [
      "reschedule",
      rescheduleMeetingSchema,
      { scheduleId: "schedule_1", expectedRevision: 1, ...schedule },
    ],
  ])("strips unknown v1 %s fields", (_name, schema, input) => {
    expect(v.parse(schema, { ...input, unexpected: true })).not.toHaveProperty("unexpected");
  });

  it.each([
    getMeetingScheduleSchema,
    cancelMeetingScheduleSchema,
    rescheduleMeetingSchema,
  ])("keeps accepting legacy v1 schedule-id lengths", (schema) => {
    expect(v.safeParse(schema, {
      scheduleId: "s".repeat(81),
      expectedRevision: 1,
      ...schedule,
    }).success).toBe(true);
  });
});

describe("meeting reminders", () => {
  it("keeps reminder defaults in the product UI so existing API clients remain unchanged", () => {
    expect(v.parse(createMeetingScheduleSchema, schedule).reminderMinutesBefore).toBeUndefined();
  });

  it("allows reminders to be disabled or set from five minutes to one week", () => {
    expect(v.parse(createMeetingScheduleSchema, {
      ...schedule,
      reminderMinutesBefore: null,
    }).reminderMinutesBefore).toBeNull();
    expect(v.safeParse(createMeetingScheduleSchema, {
      ...schedule,
      reminderMinutesBefore: 5,
    }).success).toBe(true);
    expect(v.safeParse(createMeetingScheduleSchema, {
      ...schedule,
      reminderMinutesBefore: 4,
    }).success).toBe(false);
  });
});

 it.each(["2026-02-31", "2026-02-29T10:00:00Z", "Tue, 31 Feb 2026 10:00:00 GMT"])("rejects impossible dates: %s", (startsAt) => {
  expect(v.safeParse(createMeetingScheduleSchema, { ...schedule, startsAt }).success).toBe(false);
});

describe("meeting titles", () => {
  // The title becomes an email Subject, and a header cannot hold a line break.
  it("collapses line breaks and control characters", () => {
    expect(v.parse(createMeetingScheduleSchema, {
      ...schedule,
      title: "  Standup\r\nBcc: evil@example.com  ",
    }).title).toBe("Standup Bcc: evil@example.com");
  });

  it("measures the length limit after collapsing", () => {
    expect(v.safeParse(createMeetingScheduleSchema, {
      ...schedule,
      title: `${"a".repeat(200)}\n\n`,
    }).success).toBe(true);
    expect(v.safeParse(createMeetingScheduleSchema, {
      ...schedule,
      title: "a".repeat(201),
    }).success).toBe(false);
  });
});

describe("automation schedule targets", () => {
  it("reports a target conflict alongside unrelated field errors", () => {
    const result = v.safeParse(createAutomationMeetingScheduleSchema, {
      ...schedule,
      durationMinutes: 5,
      spaceId: "space-1",
      spaceName: "Design",
    });
    expect(result.success).toBe(false);
    expect(result.issues?.map((issue) => v.getDotPath(issue))).toEqual(["durationMinutes", "spaceName"]);
  });
});

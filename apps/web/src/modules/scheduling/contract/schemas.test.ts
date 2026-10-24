import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { createMeetingScheduleFromAppSchema } from "./schemas";

const validInput = {
  title: "Planning",
  startsAt: "2026-10-01T10:00:00.000Z",
  durationMinutes: 30,
  timeZone: "Asia/Dhaka",
  joinPolicy: "open" as const,
  attendees: [],
};

describe("createMeetingScheduleFromAppSchema", () => {
  it("matches the database's 128-character idempotency-key bound", () => {
    expect(v.safeParse(createMeetingScheduleFromAppSchema, {
      ...validInput,
      idempotencyKey: "x".repeat(128),
    }).success).toBe(true);
    expect(v.safeParse(createMeetingScheduleFromAppSchema, {
      ...validInput,
      idempotencyKey: "x".repeat(129),
    }).success).toBe(false);
  });
});

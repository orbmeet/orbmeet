import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  calendarDateSchema,
  emailSchema,
  idSchema,
  MAX_ID_LENGTH,
  meetingTitleSchema,
  timeZoneHintSchema,
  timeZoneSchema,
} from "./fields";

describe("emailSchema", () => {
  it.each(["ann@example.com", "o'brien@example.co.uk", "first.last+tag@sub.example.org"])(
    "accepts %s",
    (email) => expect(v.is(emailSchema, email)).toBe(true),
  );

  it.each(["", "ann", "ann@", "@example.com", ".ann@example.com", "a..b@example.com", "ann@example"])(
    "rejects %s",
    (email) => expect(v.is(emailSchema, email)).toBe(false),
  );
});

describe("calendarDateSchema", () => {
  it("knows leap years", () => {
    expect(v.is(calendarDateSchema, "2028-02-29")).toBe(true);
    expect(v.is(calendarDateSchema, "2026-02-29")).toBe(false);
    expect(v.is(calendarDateSchema, "2026-04-31")).toBe(false);
  });
});

describe("timeZoneSchema", () => {
  it("trims and validates against the runtime's zone database", () => {
    expect(v.parse(timeZoneSchema, " Asia/Dhaka ")).toBe("Asia/Dhaka");
    expect(v.is(timeZoneSchema, "UTC")).toBe(true);
    expect(v.is(timeZoneSchema, "Mars/Olympus_Mons")).toBe(false);
    expect(v.is(timeZoneSchema, "")).toBe(false);
    expect(v.is(timeZoneSchema, "x".repeat(101))).toBe(false);
  });
});

describe("idSchema", () => {
  it("accepts minted ids and bounds what a client can send back", () => {
    expect(v.is(idSchema, "whiteboard_edit_grant_01jb2r7m4vq8x9k3n5p6t2w8zc")).toBe(true);
    expect(v.is(idSchema, "")).toBe(false);
    expect(v.is(idSchema, "x".repeat(MAX_ID_LENGTH + 1))).toBe(false);
  });
});

describe("meetingTitleSchema", () => {
  it("collapses control characters and whitespace a mail subject cannot carry", () => {
    expect(v.parse(meetingTitleSchema, "  Weekly\r\nsync\t ")).toBe("Weekly sync");
    expect(v.parse(meetingTitleSchema, "   ")).toBe("");
  });
});

describe("timeZoneHintSchema", () => {
  it("bounds a hint without requiring the runtime to know the zone", () => {
    expect(v.parse(timeZoneHintSchema, " Mars/Olympus_Mons ")).toBe("Mars/Olympus_Mons");
    expect(v.is(timeZoneHintSchema, "x".repeat(101))).toBe(false);
  });
});

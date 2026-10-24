import { describe, expect, it } from "vitest";

import {
  buildSelectorParams,
  looksLikeMeetingId,
  looksLikeScheduleId,
  meetingSelectionParams,
  normalizeMeetingIncludes,
  selectionTitle,
} from "./selectors.ts";
import type { OptionValue, ParsedArgs } from "./args.ts";

const VALID_ID_BODY = "0123456789abcdefghjkmnpqrs";

function makeArgs(
  positional: string[],
  entries: [string, OptionValue][] = [],
): ParsedArgs {
  return { positional, options: new Map(entries) };
}

describe("id detection", () => {
  it("matches only full prefix + 26-char Crockford Base32 ids", () => {
    expect(looksLikeScheduleId(`schedule_${VALID_ID_BODY}`)).toBe(true);
    expect(looksLikeMeetingId(`meeting_${VALID_ID_BODY}`)).toBe(true);
  });

  it("leaves id-like titles selectable", () => {
    expect(looksLikeScheduleId("schedule_kickoff")).toBe(false);
    expect(looksLikeScheduleId(`schedule_attendee_${VALID_ID_BODY}`)).toBe(false);
    expect(looksLikeScheduleId(`schedule_${VALID_ID_BODY}i`)).toBe(false);
    expect(looksLikeScheduleId("")).toBe(false);
    expect(looksLikeMeetingId("meeting_notes")).toBe(false);
  });
});

describe("selectionTitle", () => {
  it("prefers --title, falling back to positionals after the command", () => {
    expect(selectionTitle(makeArgs(["cancel", "Weekly", "Sync"]))).toBe("Weekly Sync");
    expect(selectionTitle(makeArgs(["cancel", "Weekly"], [["title", "Other"]]))).toBe("Other");
    expect(selectionTitle(makeArgs(["cancel"]))).toBe("");
  });
});

describe("buildSelectorParams", () => {
  it("requires at least one selector", () => {
    expect(() => buildSelectorParams(makeArgs(["cancel"]), "meeting"))
      .toThrow("Select the meeting with a title, --date, --space, or --with");
  });

  it("rejects multiple --with values", () => {
    expect(() => buildSelectorParams(
      makeArgs(["cancel"], [["with", ["Ana", "Bo"]]]),
      "meeting",
    )).toThrow("Use one --with value");
  });

  it("builds selector params with a timezone", () => {
    const params = buildSelectorParams(
      makeArgs(["cancel", "Standup"], [
        ["date", "2026-07-20"],
        ["space", "Design"],
        ["with", ["Ana"]],
        ["selector-timezone", "Asia/Dhaka"],
      ]),
      "meeting",
    );
    expect(Object.fromEntries(params)).toEqual({
      date: "2026-07-20",
      title: "Standup",
      space: "Design",
      participant: "Ana",
      timezone: "Asia/Dhaka",
    });
  });
});

describe("meetingSelectionParams", () => {
  it("uses an explicit --meeting-id directly", () => {
    const params = meetingSelectionParams(makeArgs(["meeting"], [["meeting-id", "meeting_x"]]));
    expect(Object.fromEntries(params)).toEqual({ meetingId: "meeting_x" });
  });

  it("treats an id-shaped title as an id", () => {
    const params = meetingSelectionParams(makeArgs(["meeting", `meeting_${VALID_ID_BODY}`]));
    expect(Object.fromEntries(params)).toEqual({ meetingId: `meeting_${VALID_ID_BODY}` });
  });

  it("treats everything else as a selector", () => {
    const params = meetingSelectionParams(
      makeArgs(["meeting", "Standup"], [["timezone", "UTC"]]),
    );
    expect(Object.fromEntries(params)).toEqual({ title: "Standup", timezone: "UTC" });
  });
});

describe("normalizeMeetingIncludes", () => {
  it("normalizes aliases, splits commas, and dedupes", () => {
    expect(normalizeMeetingIncludes(["recording", "whiteboard", "summary,transcript", "summary"]))
      .toEqual(["recordings", "whiteboard_pdf", "summary", "transcript"]);
  });

  it("trims padding, skips empty tokens, and ignores case", () => {
    expect(normalizeMeetingIncludes(["summary, transcript", "Recordings,"]))
      .toEqual(["summary", "transcript", "recordings"]);
  });

  it("rejects unknown content names and all-empty input", () => {
    expect(() => normalizeMeetingIncludes(["notes"])).toThrow("Unknown Meeting content: notes");
    expect(() => normalizeMeetingIncludes([","])).toThrow("--include requires at least one of");
  });
});

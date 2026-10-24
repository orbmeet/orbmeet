import { describe, expect, it } from "vitest";
import {
  meetingEntryPath,
  meetingHistoryPath,
  meetingWhiteboardPath,
} from "./urls";

describe("meeting URL contract", () => {
  it("separates entry credentials from stable Meeting history", () => {
    expect(meetingEntryPath("vyf-fadu-gvw")).toBe("/vyf-fadu-gvw");
    expect(meetingHistoryPath("mtg_123")).toBe("/meetings/mtg_123");
    expect(meetingWhiteboardPath("mtg_123")).toBe("/meetings/mtg_123#whiteboard");
  });

  it("URL-encodes the stable identifier defensively", () => {
    expect(meetingHistoryPath("meeting/123")).toBe("/meetings/meeting%2F123");
  });
});

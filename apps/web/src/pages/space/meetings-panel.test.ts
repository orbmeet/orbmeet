import { describe, expect, it } from "vitest";

import { buildMeetingMetaParts } from "./meetings-panel";

const meeting = {
  startedAt: "2026-09-08T04:00:00Z",
  endedAt: "2026-09-08T04:30:00Z",
  retainUntil: null,
  starterName: "Atiq Rahman",
};

describe("Space meeting meta line", () => {
  it("says nothing about retention when there is no deadline", () => {
    const parts = buildMeetingMetaParts(meeting, null);

    expect(parts.join(" · ")).not.toContain("expiry");
    expect(parts).toEqual(["30m", "Started by Atiq Rahman"]);
  });

  it("shows a retention deadline when one is set", () => {
    const parts = buildMeetingMetaParts({ ...meeting, retainUntil: "2026-10-08T04:30:00Z" }, null);

    expect(parts.some((part) => part.startsWith("Available until "))).toBe(true);
  });

  it("leads with the date and time only once a title has taken the heading", () => {
    const untitled = buildMeetingMetaParts(meeting, null);
    const titled = buildMeetingMetaParts(meeting, "Design review");

    expect(titled).toHaveLength(untitled.length + 2);
    expect(titled.slice(2)).toEqual(untitled);
  });

  it("omits a starter it does not know", () => {
    expect(buildMeetingMetaParts({ ...meeting, starterName: null }, null)).toEqual(["30m"]);
  });
});

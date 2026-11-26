import { describe, expect, it } from "vitest";

import { COMMAND_SPECS, type CommandName, type CommandSpec } from "./commands.ts";
import { commandHelp, globalHelp } from "./help.ts";

function specEntries(): [CommandName, CommandSpec][] {
  return Object.entries(COMMAND_SPECS) as [CommandName, CommandSpec][];
}

describe("command help", () => {
  it("shows a positional in the usage line exactly when the command reads one", () => {
    for (const [command, spec] of specEntries()) {
      expect(/\[?(TITLE|QUERY)\]?/.test(spec.usage), `usage of ${command}`)
        .toBe(Boolean(spec.positional));
    }
  });

  it("renders usage, summary, and option lines", () => {
    const text = commandHelp("reschedule");
    expect(text).toContain("Usage: orbmeet reschedule");
    expect(text).toContain("--dry-run");
    expect(text).toContain("--duration MIN");
    expect(text).toContain("defaults to the meeting's current length");
  });

  it("rejects unknown commands with a pointer to help", () => {
    expect(() => commandHelp("nonsense")).toThrow("Unknown command: nonsense. Run: orbmeet help");
  });
});

describe("global help", () => {
  const text = globalHelp();

  it("mentions every command", () => {
    const labels = Object.keys(COMMAND_SPECS).filter((command) => command !== "recording");
    expect(labels).not.toHaveLength(0);
    for (const label of labels) {
      expect(text, `global help mentions ${label}`).toContain(label);
    }
  });

  it("states the output contract and disambiguation protocol", () => {
    expect(text).toContain("stderr");
    expect(text).toContain("AMBIGUOUS_SCHEDULE");
    expect(text).toContain("AMBIGUOUS_MEETING");
    expect(text).toContain("error.details.candidates");
    expect(text).toContain("ORBMEET_TOKEN");
    expect(text).toContain("--timezone explicitly");
  });
});

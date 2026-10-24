import { describe, expect, it } from "vitest";

import { COMMAND_SPECS, type CommandName } from "./args.ts";
import { COMMAND_HELP, commandHelp, globalHelp } from "./help.ts";

function specEntries() {
  return Object.entries(COMMAND_SPECS) as [CommandName, { positional?: string; options: Record<string, unknown> }][];
}

describe("command help", () => {
  it("documents every command and no phantom commands", () => {
    expect(Object.keys(COMMAND_HELP).sort()).toEqual(Object.keys(COMMAND_SPECS).sort());
  });

  it("documents exactly the options each command accepts", () => {
    for (const [command, spec] of specEntries()) {
      expect(Object.keys(COMMAND_HELP[command].options).sort(), `options of ${command}`)
        .toEqual(Object.keys(spec.options).sort());
    }
  });

  it("shows a positional in the usage line exactly when the command reads one", () => {
    for (const [command, spec] of specEntries()) {
      const usage = COMMAND_HELP[command].usage;
      expect(/\[?(TITLE|QUERY)\]?/.test(usage), `usage of ${command}`)
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

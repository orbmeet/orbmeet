import { describe, expect, it } from "vitest";

import { COMMAND_SPECS, flag, option, optionList, parseArgs, requiredOption } from "./args.ts";

describe("parseArgs", () => {
  it("only treats help as an option before the end-of-options marker", () => {
    const parsed = parseArgs(["reschedule", "--", "--help"], COMMAND_SPECS.reschedule);

    expect(flag(parsed, "help")).toBe(false);
    expect(parsed.positional).toEqual(["reschedule", "--help"]);
  });

  it("keeps positionals after flag options instead of consuming them", () => {
    const args = parseArgs(["meeting", "--raw", "Standup"], COMMAND_SPECS.meeting);
    expect(args.positional).toEqual(["meeting", "Standup"]);
    expect(flag(args, "raw")).toBe(true);
  });

  it("rejects unknown options so typos fail loudly", () => {
    expect(() => parseArgs(["schedule", "--emial", "a@b.co"], COMMAND_SPECS.schedule))
      .toThrow("Unknown option --emial");
    expect(() => parseArgs(["meeting", "--toString", "value"], COMMAND_SPECS.meeting))
      .toThrow("Unknown option --toString");
    expect(() => parseArgs(["meeting", "--valueOf", "value"], COMMAND_SPECS.meeting))
      .toThrow("Unknown option --valueOf");
  });

  it("rejects positional words on commands that do not read them", () => {
    expect(() => parseArgs(["schedule", "Standup", "--at", "x"], COMMAND_SPECS.schedule))
      .toThrow('Unexpected argument "Standup". Run: orbmeet schedule --help');
    expect(() => parseArgs(["configure", "my-token"], COMMAND_SPECS.configure))
      .toThrow('Unexpected argument "my-token". Run: orbmeet configure --help');
  });

  it("rejects single-dash tokens instead of treating them as words", () => {
    expect(() => parseArgs(["cancel", "-t", "Standup"], COMMAND_SPECS.cancel))
      .toThrow("Unknown option -t");
  });

  it("requires a value for value options", () => {
    expect(() => parseArgs(["cancel", "X", "--reason", "--raw"], COMMAND_SPECS.cancel))
      .toThrow("Option --reason requires a value");
    expect(() => parseArgs(["configure", "--token-file"], COMMAND_SPECS.configure))
      .toThrow("Option --token-file requires a value");
    expect(() => parseArgs(["configure", "--token", "secret"], COMMAND_SPECS.configure))
      .toThrow("Unknown option --token");
  });

  it("accepts --name=value, including values that start with dashes", () => {
    const args = parseArgs(
      ["schedule", "--title=Planning --at 10", "--duration=45"],
      COMMAND_SPECS.schedule,
    );
    expect(option(args, "title")).toBe("Planning --at 10");
    expect(option(args, "duration")).toBe("45");
  });

  it("rejects repeated value options", () => {
    expect(() => parseArgs(
      ["schedule", "--duration", "30", "--duration", "45"],
      COMMAND_SPECS.schedule,
    )).toThrow("Option --duration can only be given once");
  });

  it("accumulates list options", () => {
    const args = parseArgs(
      ["schedule", "--with", "Ana", "--with", "Bo", "--email", "a@b.co"],
      COMMAND_SPECS.schedule,
    );
    expect(optionList(args, "with")).toEqual(["Ana", "Bo"]);
    expect(optionList(args, "email")).toEqual(["a@b.co"]);
    expect(optionList(args, "contact")).toEqual([]);
  });

  it("requires inline syntax for values that start with a dash", () => {
    expect(() => parseArgs(
      ["schedule", "--title", "-weird title"],
      COMMAND_SPECS.schedule,
    )).toThrow("use --title=<value> when it starts with a dash");
    const args = parseArgs(["schedule", "--title=-weird title"], COMMAND_SPECS.schedule);
    expect(option(args, "title")).toBe("-weird title");
  });

  it("treats every token after -- as positional data", () => {
    const args = parseArgs(
      ["search", "--raw", "--", "--quarterly", "-review"],
      COMMAND_SPECS.search,
    );
    expect(args.positional).toEqual(["search", "--quarterly", "-review"]);
    expect(flag(args, "raw")).toBe(true);
  });

  it("requiredOption throws when the option is absent", () => {
    const args = parseArgs(["schedule"], COMMAND_SPECS.schedule);
    expect(() => requiredOption(args, "at")).toThrow("Missing --at");
  });
});

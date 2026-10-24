// Each command spec is { positional?, options }. Option kinds: "flag" options
// never consume a value, "value" options take exactly one, "list" options may
// repeat. Anything absent from the spec is rejected so typos fail loudly
// instead of silently dropping data — including positional words on commands
// that do not read them (spec.positional names what positionals mean there).

type OptionKind = "flag" | "value" | "list";

export interface CommandSpec {
  positional?: string;
  options: Readonly<Record<string, OptionKind>>;
}

/** A flag stores `true`, a value option a string, a list option its values. */
export type OptionValue = string | string[] | true;

export interface ParsedArgs {
  positional: string[];
  options: Map<string, OptionValue>;
}

const SELECTOR_OPTIONS = {
  title: "value",
  date: "value",
  space: "value",
  with: "list",
  timezone: "value",
  "selector-timezone": "value",
  raw: "flag",
} as const satisfies Record<string, OptionKind>;

const MEETING_CONTENT_OPTIONS = { ...SELECTOR_OPTIONS, "meeting-id": "value" } as const;

export const COMMAND_SPECS = {
  configure: { options: { "token-file": "value" } },
  whoami: { options: { raw: "flag" } },
  search: { positional: "QUERY", options: { raw: "flag" } },
  schedules: { options: { raw: "flag" } },
  schedule: {
    options: {
      title: "value",
      at: "value",
      timezone: "value",
      duration: "value",
      with: "list",
      email: "list",
      contact: "list",
      space: "value",
      "space-id": "value",
      approval: "flag",
      "idempotency-key": "value",
      raw: "flag",
    },
  },
  reschedule: {
    positional: "TITLE",
    options: { ...SELECTOR_OPTIONS, at: "value", duration: "value", "dry-run": "flag" },
  },
  cancel: {
    positional: "TITLE",
    options: { ...SELECTOR_OPTIONS, reason: "value", "dry-run": "flag" },
  },
  meeting: { positional: "TITLE", options: MEETING_CONTENT_OPTIONS },
  summary: { positional: "TITLE", options: MEETING_CONTENT_OPTIONS },
  transcript: {
    positional: "TITLE",
    options: { ...MEETING_CONTENT_OPTIONS, "transcript-limit": "value" },
  },
  recording: { positional: "TITLE", options: MEETING_CONTENT_OPTIONS },
  recordings: { positional: "TITLE", options: MEETING_CONTENT_OPTIONS },
  whiteboard: { positional: "TITLE", options: MEETING_CONTENT_OPTIONS },
  retrieve: {
    positional: "TITLE",
    options: { ...MEETING_CONTENT_OPTIONS, include: "list", "transcript-limit": "value" },
  },
  version: { options: {} },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMAND_SPECS;

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(COMMAND_SPECS, value);
}

export function parseArgs(argv: readonly string[], spec: CommandSpec): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, OptionValue>();
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "--help" || token === "-h")) {
      options.set("help", true);
      continue;
    }
    if (!optionsEnded && token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      const inline = equals === -1 ? undefined : token.slice(equals + 1);
      if (!Object.hasOwn(spec.options, name)) throw new Error(`Unknown option --${name}`);
      const kind = spec.options[name];
      if (kind === "flag") {
        if (inline !== undefined) throw new Error(`Option --${name} does not take a value`);
        options.set(name, true);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = argv[index + 1];
        if (next === undefined) {
          throw new Error(`Option --${name} requires a value`);
        }
        if (next.startsWith("-")) {
          throw new Error(
            `Option --${name} requires a value; use --${name}=<value> when it starts with a dash`,
          );
        }
        index++;
        value = next;
      }
      if (kind === "list") {
        const existing = options.get(name);
        options.set(name, [...(Array.isArray(existing) ? existing : []), value]);
        continue;
      }
      if (options.has(name)) throw new Error(`Option --${name} can only be given once`);
      options.set(name, value);
      continue;
    }
    if (!optionsEnded && token.startsWith("-") && token.length > 1) {
      throw new Error(`Unknown option ${token} (options are spelled --${token.replace(/^-+/, "")})`);
    }
    positional.push(token);
  }
  if (!spec.positional && positional.length > 1) {
    throw new Error(
      `Unexpected argument "${positional[1]}". Run: orbmeet ${positional[0]} --help`,
    );
  }
  return { positional, options };
}

/** The value of a "value" option, or undefined when it was not given. */
export function option(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Whether a "flag" option was given. */
export function flag(args: ParsedArgs, name: string): boolean {
  return args.options.get(name) === true;
}

/** Every value of a "list" option, in the order given. */
export function optionList(args: ParsedArgs, name: string): string[] {
  const value = args.options.get(name);
  return Array.isArray(value) ? value : [];
}

export function requiredOption(args: ParsedArgs, name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Error(`Missing --${name}`);
  return value;
}

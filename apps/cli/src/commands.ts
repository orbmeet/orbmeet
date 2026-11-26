// Single declarative registry of every CLI command and its options.
// Both `parseArgs` (args.ts) and `commandHelp` (help.ts) read from this table,
// so accepted flags/values/positionals and rendered help cannot drift.
//
// Option kinds:
// - "flag": never consumes a value (and carries no placeholder in help).
// - "value": takes a single value and cannot repeat.
// - "list": takes a value and may repeat.
// Anything absent from a command's spec is rejected loudly on parse.

export type OptionSpec =
  | { readonly kind: "flag"; readonly description: string }
  | { readonly kind: "value" | "list"; readonly placeholder: string; readonly description: string };

export interface CommandSpec {
  readonly positional?: string;
  readonly summary: string;
  readonly usage: string;
  readonly options: Readonly<Record<string, OptionSpec>>;
  readonly output: string;
  readonly notes: readonly string[];
}

const RAW: OptionSpec = {
  kind: "flag",
  description: "Print the API response payload instead of the shaped output",
};

const SELECTOR_OPTIONS = {
  title: { kind: "value", placeholder: "TEXT", description: "Match by title (or pass TITLE as positional words)" },
  date: { kind: "value", placeholder: "YYYY-MM-DD", description: "Match meetings on this local date" },
  space: { kind: "value", placeholder: "NAME", description: "Match by Space name" },
  with: { kind: "list", placeholder: "NAME", description: "Match by a participant's name (use one value when selecting)" },
  timezone: { kind: "value", placeholder: "ZONE", description: "IANA zone for interpreting times and --date (defaults to this machine's)" },
  "selector-timezone": { kind: "value", placeholder: "ZONE", description: "Zone for interpreting --date only, when it must differ from --timezone" },
  raw: RAW,
} as const satisfies Record<string, OptionSpec>;

const MEETING_CONTENT_OPTIONS = {
  ...SELECTOR_OPTIONS,
  "meeting-id": {
    kind: "value",
    placeholder: "ID",
    description: "Exact Meeting id (meeting_…) from earlier output; skips fuzzy selection",
  },
} as const satisfies Record<string, OptionSpec>;

const TRANSCRIPT_LIMIT: OptionSpec = {
  kind: "value",
  placeholder: "N",
  description: "Fetch at most N transcript segments; sets transcriptTruncated when more exist",
};

const SELECTOR_NOTE =
  "One match proceeds; several matches fail with AMBIGUOUS_* and safe candidates in error.details.";

function meetingContentCommand(
  summary: string,
  command: string,
  extraOptions: Readonly<Record<string, OptionSpec>> = {},
  notes: readonly string[] = [
    SELECTOR_NOTE,
    "Only ended Meetings are searched; use `schedules` for upcoming ones.",
  ],
): CommandSpec {
  return {
    positional: "TITLE",
    summary,
    usage: `orbmeet ${command} [TITLE] [selectors]`,
    options: { ...MEETING_CONTENT_OPTIONS, ...extraOptions },
    output: "JSON with meeting {id, title, startedAt, …}, available content flags, and the requested content.",
    notes,
  };
}

export const COMMAND_SPECS = {
  configure: {
    summary: "Store the API token for this machine",
    usage: "printf '%s' \"$ORBMEET_TOKEN\" | orbmeet configure",
    options: {
      "token-file": {
        kind: "value",
        placeholder: "PATH",
        description: "Read the token from a protected file instead of stdin",
      },
    },
    output: "JSON {configured, cloud, configPath}.",
    notes: [
      "The token is written with 0600 permissions.",
      "Token values are never accepted in argv, where shell history and process listings expose them.",
      "With no --token-file, a token piped on stdin is stored; with none, a set ORBMEET_TOKEN is.",
      "The ORBMEET_TOKEN environment variable overrides the stored token.",
      "Run `orbmeet whoami` afterwards to verify it.",
    ],
  },
  whoami: {
    summary: "Verify the token and report who commands act as",
    usage: "orbmeet whoami",
    options: { raw: RAW },
    output: "JSON {user, scopes, serverTime, homeTimeZone, machineTimeZone, effectiveTimeZone, timeZoneSource}.",
    notes: [
      "Run this first: it confirms auth, shows the token's scopes (meetings:read / meetings:write),",
      "and returns serverTime as a trustworthy current-time reference.",
    ],
  },
  search: {
    positional: "QUERY",
    summary: "Find people and Spaces by name or email",
    usage: "orbmeet search QUERY",
    options: { raw: RAW },
    output: "JSON {query, requiresConfirmation, candidates: [{type, name, email?, …}]}.",
    notes: ["When requiresConfirmation is true, confirm the intended person or Space with the user before scheduling."],
  },
  schedules: {
    summary: "List upcoming scheduled meetings you organize or attend",
    usage: "orbmeet schedules",
    options: { raw: RAW },
    output: "JSON {meetings: [{title, startsAt, endsAt, timeZone, state, attendees, joinUrl, canManage}]}.",
    notes: ["Use this to preview what a `cancel` or `reschedule` selector would match."],
  },
  schedule: {
    summary: "Create a scheduled Meeting and notify people by email",
    usage: 'orbmeet schedule --at TIME [--title TEXT] [--with NAME]... [--email ADDR]...',
    options: {
      at: { kind: "value", placeholder: "TIME", description: 'Start time (required): ISO instant or "YYYY-MM-DD HH:mm" in --timezone' },
      title: { kind: "value", placeholder: "TEXT", description: "Meeting title" },
      timezone: { kind: "value", placeholder: "ZONE", description: "IANA zone for --at and reminders (defaults to ORBMEET_TIMEZONE, then your account home zone)" },
      duration: { kind: "value", placeholder: "MIN", description: "Length in minutes, 15–1440 (default 30)" },
      with: { kind: "list", placeholder: "NAME", description: "Notify a known contact by email (repeatable; ambiguous names fail with candidates)" },
      email: { kind: "list", placeholder: "ADDR", description: "Send the scheduled time and join link to an email address (repeatable; no RSVP collection)" },
      space: { kind: "value", placeholder: "NAME", description: "Attach the meeting to a Space by name" },
      contact: { kind: "list", placeholder: "ID", description: "Notify by internal contact id (escape hatch; ids appear only in --raw output)" },
      "space-id": { kind: "value", placeholder: "ID", description: "Attach by internal Space id (escape hatch)" },
      approval: { kind: "flag", description: "Require the organizer to approve joins" },
      "idempotency-key": { kind: "value", placeholder: "KEY", description: "Stable key so a retried command cannot double-create (default: random per run)" },
      raw: RAW,
    },
    output: 'JSON {status: "scheduled", meeting: {id, title, startsAt, endsAt, timeZone, joinUrl, …}}.',
    notes: [
      "Keep the returned meeting id (schedule_…): it reschedules or cancels this exact meeting later.",
      "Scripts that retry should pass their own --idempotency-key.",
    ],
  },
  reschedule: {
    positional: "TITLE",
    summary: "Move a scheduled meeting to a new time",
    usage: "orbmeet reschedule [TITLE] --at TIME [selectors]",
    options: {
      ...SELECTOR_OPTIONS,
      at: { kind: "value", placeholder: "TIME", description: 'New start time (required): ISO instant or "YYYY-MM-DD HH:mm" in --timezone' },
      duration: { kind: "value", placeholder: "MIN", description: "New length in minutes (defaults to the meeting's current length)" },
      timezone: { kind: "value", placeholder: "ZONE", description: "New zone for the meeting (defaults to the meeting's current zone)" },
      "dry-run": { kind: "flag", description: "Show which meeting matched and the planned change without applying it" },
    },
    output: 'JSON {status: "rescheduled" | "dry_run", meeting: {id, …}, change?}.',
    notes: [
      SELECTOR_NOTE,
      "A schedule_… id can replace TITLE to target one exact meeting.",
      "Duration and time zone are preserved unless explicitly overridden.",
    ],
  },
  cancel: {
    positional: "TITLE",
    summary: "Cancel a scheduled meeting and notify attendees",
    usage: "orbmeet cancel [TITLE] [selectors] [--reason TEXT]",
    options: {
      ...SELECTOR_OPTIONS,
      reason: { kind: "value", placeholder: "TEXT", description: "Optional reason included in the cancellation notice" },
      "dry-run": { kind: "flag", description: "Show which meeting would be canceled without canceling it" },
    },
    output: 'JSON {status: "canceled" | "already_canceled" | "dry_run", meeting: {id, …}}.',
    notes: [
      SELECTOR_NOTE,
      "Cancellation is immediate and notifies attendees — preview with --dry-run or `schedules` first.",
    ],
  },
  meeting: meetingContentCommand("Show an ended Meeting and which content is available", "meeting"),
  summary: meetingContentCommand("Fetch the AI Summary of an ended Meeting", "summary"),
  transcript: meetingContentCommand("Fetch the transcript of an ended Meeting", "transcript", {
    "transcript-limit": TRANSCRIPT_LIMIT,
  }),
  recording: meetingContentCommand("List an ended Meeting's recordings with download links", "recording"),
  recordings: meetingContentCommand("List an ended Meeting's recordings with download links", "recordings"),
  whiteboard: meetingContentCommand("Fetch an ended Meeting's Whiteboard PDF link", "whiteboard"),
  retrieve: meetingContentCommand(
    "Fetch several kinds of Meeting content at once",
    "retrieve",
    {
      include: {
        kind: "list",
        placeholder: "KIND",
        description: "summary, transcript, recordings, or whiteboard (repeat or comma-separate; default: summary)",
      },
      "transcript-limit": TRANSCRIPT_LIMIT,
    },
    [
      SELECTOR_NOTE,
      "Defaults to the summary only — full transcripts can be very large; request them deliberately,",
      "and cap them with --transcript-limit when only the beginning is needed.",
    ],
  ),
  version: {
    summary: "Print the CLI version",
    usage: "orbmeet version",
    options: {},
    output: "JSON {name, version}.",
    notes: [],
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMAND_SPECS;

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(COMMAND_SPECS, value);
}

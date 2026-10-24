import { CLOUD_API_URL, CONFIG_PATH } from "./config.ts";
import type { CommandName } from "./args.ts";

/** [PLACEHOLDER, description]; flags use "" as the placeholder. */
type OptionHelp = readonly [placeholder: string, description: string];

export interface CommandHelpEntry {
  summary: string;
  usage: string;
  options: Readonly<Record<string, OptionHelp>>;
  output: string;
  notes: readonly string[];
}

// Every option is documented as [PLACEHOLDER, description]; flags use "".
// help.test.ts asserts these entries stay in lockstep with COMMAND_OPTIONS.

const RAW: OptionHelp = ["", "Print the API response payload instead of the shaped output"];
const SELECTOR_OPTIONS_HELP = {
  title: ["TEXT", "Match by title (or pass TITLE as positional words)"],
  date: ["YYYY-MM-DD", "Match meetings on this local date"],
  space: ["NAME", "Match by Space name"],
  with: ["NAME", "Match by a participant's name (use one value when selecting)"],
  timezone: ["ZONE", "IANA zone for interpreting times and --date (defaults to this machine's)"],
  "selector-timezone": ["ZONE", "Zone for interpreting --date only, when it must differ from --timezone"],
  raw: RAW,
} as const satisfies Record<string, OptionHelp>;
const MEETING_ID: OptionHelp = ["ID", "Exact Meeting id (meeting_…) from earlier output; skips fuzzy selection"];
const TRANSCRIPT_LIMIT: OptionHelp = ["N", "Fetch at most N transcript segments; sets transcriptTruncated when more exist"];
const SELECTOR_NOTE = "One match proceeds; several matches fail with AMBIGUOUS_* and safe candidates in error.details.";

function meetingContentEntry(
  summary: string,
  command: string,
  extraOptions: Readonly<Record<string, OptionHelp>> = {},
): CommandHelpEntry {
  return {
    summary,
    usage: `orbmeet ${command} [TITLE] [selectors]`,
    options: { ...SELECTOR_OPTIONS_HELP, "meeting-id": MEETING_ID, ...extraOptions },
    output: "JSON with meeting {id, title, startedAt, …}, available content flags, and the requested content.",
    notes: [SELECTOR_NOTE, "Only ended Meetings are searched; use `schedules` for upcoming ones."],
  };
}

export const COMMAND_HELP = {
  configure: {
    summary: "Store the API token for this machine",
    usage: "printf '%s' \"$ORBMEET_TOKEN\" | orbmeet configure",
    options: { "token-file": ["PATH", "Read the token from a protected file instead of stdin"] },
    output: "JSON {configured, cloud, configPath}.",
    notes: [
      "The token is written with 0600 permissions.",
      "Token values are never accepted in argv, where shell history and process listings expose them.",
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
      at: ["TIME", 'Start time (required): ISO instant or "YYYY-MM-DD HH:mm" in --timezone'],
      title: ["TEXT", "Meeting title"],
      timezone: ["ZONE", "IANA zone for --at and reminders (defaults to ORBMEET_TIMEZONE, then your account home zone)"],
      duration: ["MIN", "Length in minutes, 15–1440 (default 30)"],
      with: ["NAME", "Notify a known contact by email (repeatable; ambiguous names fail with candidates)"],
      email: ["ADDR", "Send the scheduled time and join link to an email address (repeatable; no RSVP collection)"],
      space: ["NAME", "Attach the meeting to a Space by name"],
      contact: ["ID", "Notify by internal contact id (escape hatch; ids appear only in --raw output)"],
      "space-id": ["ID", "Attach by internal Space id (escape hatch)"],
      approval: ["", "Require the organizer to approve joins"],
      "idempotency-key": ["KEY", "Stable key so a retried command cannot double-create (default: random per run)"],
      raw: RAW,
    },
    output: "JSON {status: \"scheduled\", meeting: {id, title, startsAt, endsAt, timeZone, joinUrl, …}}.",
    notes: [
      "Keep the returned meeting id (schedule_…): it reschedules or cancels this exact meeting later.",
      "Scripts that retry should pass their own --idempotency-key.",
    ],
  },
  reschedule: {
    summary: "Move a scheduled meeting to a new time",
    usage: "orbmeet reschedule [TITLE] --at TIME [selectors]",
    options: {
      ...SELECTOR_OPTIONS_HELP,
      at: ["TIME", 'New start time (required): ISO instant or "YYYY-MM-DD HH:mm" in --timezone'],
      duration: ["MIN", "New length in minutes (defaults to the meeting's current length)"],
      timezone: ["ZONE", "New zone for the meeting (defaults to the meeting's current zone)"],
      "dry-run": ["", "Show which meeting matched and the planned change without applying it"],
    },
    output: "JSON {status: \"rescheduled\" | \"dry_run\", meeting: {id, …}, change?}.",
    notes: [
      SELECTOR_NOTE,
      "A schedule_… id can replace TITLE to target one exact meeting.",
      "Duration and time zone are preserved unless explicitly overridden.",
    ],
  },
  cancel: {
    summary: "Cancel a scheduled meeting and notify attendees",
    usage: "orbmeet cancel [TITLE] [selectors] [--reason TEXT]",
    options: {
      ...SELECTOR_OPTIONS_HELP,
      reason: ["TEXT", "Optional reason included in the cancellation notice"],
      "dry-run": ["", "Show which meeting would be canceled without canceling it"],
    },
    output: "JSON {status: \"canceled\" | \"already_canceled\" | \"dry_run\", meeting: {id, …}}.",
    notes: [
      SELECTOR_NOTE,
      "Cancellation is immediate and notifies attendees — preview with --dry-run or `schedules` first.",
    ],
  },
  meeting: meetingContentEntry("Show an ended Meeting and which content is available", "meeting"),
  summary: meetingContentEntry("Fetch the AI Summary of an ended Meeting", "summary"),
  transcript: meetingContentEntry("Fetch the transcript of an ended Meeting", "transcript", {
    "transcript-limit": TRANSCRIPT_LIMIT,
  }),
  recording: meetingContentEntry("List an ended Meeting's recordings with download links", "recording"),
  recordings: meetingContentEntry("List an ended Meeting's recordings with download links", "recordings"),
  whiteboard: meetingContentEntry("Fetch an ended Meeting's Whiteboard PDF link", "whiteboard"),
  retrieve: {
    ...meetingContentEntry("Fetch several kinds of Meeting content at once", "retrieve", {
      include: ["KIND", "summary, transcript, recordings, or whiteboard (repeat or comma-separate; default: summary)"],
      "transcript-limit": TRANSCRIPT_LIMIT,
    }),
    notes: [
      SELECTOR_NOTE,
      "Defaults to the summary only — full transcripts can be very large; request them deliberately,",
      "and cap them with --transcript-limit when only the beginning is needed.",
    ],
  },
  version: {
    summary: "Print the CLI version",
    usage: "orbmeet version",
    options: {},
    output: "JSON {name, version}.",
    notes: [],
  },
} as const satisfies Record<CommandName, CommandHelpEntry>;

function optionLines(options: Readonly<Record<string, OptionHelp>>): string {
  const entries = Object.entries(options);
  if (entries.length === 0) return "";
  const labels = entries.map(([name, [placeholder]]) =>
    `--${name}${placeholder ? ` ${placeholder}` : ""}`);
  const width = Math.max(...labels.map((label) => label.length)) + 2;
  const lines = entries.map(([, [, description]], index) =>
    `  ${labels[index].padEnd(width)}${description}`);
  return `\nOptions:\n${lines.join("\n")}\n`;
}

export function commandHelp(command: string): string {
  const entry: CommandHelpEntry | undefined =
    COMMAND_HELP[command as CommandName];
  if (!entry) throw new Error(`Unknown command: ${command}. Run: orbmeet help`);
  const notes = entry.notes.length > 0 ? `\n${entry.notes.map((note) => `${note}`).join("\n")}\n` : "";
  return `Usage: ${entry.usage}

${entry.summary}.
${optionLines(entry.options)}
Output: ${entry.output}
${notes}`;
}

export function globalHelp(): string {
  return `orbmeet — schedule meetings and retrieve meeting content (orbmeet.com)

Usage: orbmeet <command> [options]
       orbmeet <command> --help   detailed help for one command

Setup
  configure    Store the API token (or set ORBMEET_TOKEN)
  whoami       Verify the token; shows user, scopes, and current server time
  version      Print the CLI version

Scheduled meetings
  search       Find people and Spaces by name or email
  schedules    List upcoming scheduled meetings
  schedule     Create a scheduled meeting
  reschedule   Move a scheduled meeting (keeps duration/zone unless overridden)
  cancel       Cancel a scheduled meeting (--dry-run to preview)

Ended meetings
  meeting      Show basics and which content is available
  summary      AI Summary of the discussion
  transcript   Full transcript (--transcript-limit N to cap)
  recordings   Recordings with signed download links
  whiteboard   Whiteboard PDF export link
  retrieve     Several kinds at once (--include …; defaults to summary)

Output contract
  Success prints JSON on stdout. Failure prints {"error": {"code", "message",
  "details"}} on stderr and exits 1.

Selecting a meeting
  Describe what people remember: TITLE (positional words), --date, --space,
  --with. Exactly one match proceeds; several matches fail with code
  AMBIGUOUS_SCHEDULE or AMBIGUOUS_MEETING and error.details.candidates listing
  title, time, space, and participants — never ids, so show them to the user
  and retry with a narrower selector. Ids printed by this CLI's own output
  (schedule_…, meeting_…) are accepted wherever TITLE goes.

Times
  --at accepts an ISO instant (2026-07-20T15:00:00Z) or a wall clock
  "YYYY-MM-DD HH:mm" resolved in --timezone. Zone precedence is --timezone,
  ORBMEET_TIMEZONE, your account home zone, then this machine's zone with a
  warning. Pass --timezone explicitly for a one-off overseas meeting. Use
  \`whoami\` to inspect the effective zone and server time.

Error codes
  UNAUTHORIZED bad or expired token · FORBIDDEN token lacks the needed scope ·
  VALIDATION_ERROR invalid input · SCHEDULE_NOT_FOUND / MEETING_NOT_FOUND no
  match · AMBIGUOUS_SCHEDULE / AMBIGUOUS_MEETING several matches (see
  error.details.candidates) · RATE_LIMITED retry later · CLI_ERROR local error

Cloud: ${CLOUD_API_URL}   Config: ${CONFIG_PATH}   Token override: ORBMEET_TOKEN
`;
}

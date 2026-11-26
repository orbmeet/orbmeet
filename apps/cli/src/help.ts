import { COMMAND_SPECS, isCommandName, type OptionSpec } from "./commands.ts";
import { CLOUD_API_URL, CONFIG_PATH } from "./config.ts";

function optionLines(options: Readonly<Record<string, OptionSpec>>): string {
  const entries = Object.entries(options);
  if (entries.length === 0) return "";
  const labels = entries.map(([name, spec]) =>
    spec.kind === "flag" ? `--${name}` : `--${name} ${spec.placeholder}`);
  const width = Math.max(...labels.map((label) => label.length)) + 2;
  const lines = entries.map(([, spec], index) =>
    `  ${labels[index].padEnd(width)}${spec.description}`);
  return `\nOptions:\n${lines.join("\n")}\n`;
}

export function commandHelp(command: string): string {
  if (!isCommandName(command)) throw new Error(`Unknown command: ${command}. Run: orbmeet help`);
  const entry = COMMAND_SPECS[command];
  const notes = entry.notes.length > 0 ? `\n${entry.notes.join("\n")}\n` : "";
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

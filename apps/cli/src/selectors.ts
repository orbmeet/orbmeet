import { option, optionList, type ParsedArgs } from "./args.ts";
import { assertTimeZone, localTimeZone } from "./time.ts";

/** Meeting content kinds the API accepts in `include`. */
export type MeetingInclude = "summary" | "transcript" | "recordings" | "whiteboard_pdf";

// Server IDs are a type prefix plus exactly 26 lowercase Crockford Base32
// characters (apps/web/src/modules/meetings/client/code-generation.ts). Matching the full shape keeps
// titles that merely start with "schedule_" usable as selectors.
const SORTABLE_ID_BODY = "[0-9a-hjkmnp-tv-z]{26}";
const SCHEDULE_ID = new RegExp(`^schedule_${SORTABLE_ID_BODY}$`);
const MEETING_ID = new RegExp(`^meeting_${SORTABLE_ID_BODY}$`);

export function looksLikeScheduleId(value: string | undefined): boolean {
  return SCHEDULE_ID.test(value || "");
}

export function looksLikeMeetingId(value: string | undefined): boolean {
  return MEETING_ID.test(value || "");
}

export function selectionTitle(args: ParsedArgs): string {
  return (option(args, "title") ?? args.positional.slice(1).join(" ")).trim();
}

function selectorTimeZone(args: ParsedArgs): string {
  const explicit = option(args, "selector-timezone") || option(args, "timezone");
  if (explicit) return assertTimeZone(explicit, "Selector time zone");
  if (process.env.ORBMEET_TIMEZONE) {
    return assertTimeZone(process.env.ORBMEET_TIMEZONE, "ORBMEET_TIMEZONE");
  }
  return localTimeZone();
}

export function buildSelectorParams(args: ParsedArgs, subject: string): URLSearchParams {
  const participants = optionList(args, "with");
  if (participants.length > 1) {
    throw new Error(`Use one --with value when selecting an existing ${subject}`);
  }
  const params = new URLSearchParams();
  const title = selectionTitle(args);
  const date = option(args, "date");
  const space = option(args, "space");
  if (date) params.set("date", date);
  if (title) params.set("title", title);
  if (space) params.set("space", space);
  if (participants[0]) params.set("participant", participants[0]);
  if ([...params.keys()].length === 0) {
    throw new Error(`Select the ${subject} with a title, --date, --space, or --with`);
  }
  params.set("timezone", selectorTimeZone(args));
  return params;
}

export function meetingSelectionParams(args: ParsedArgs): URLSearchParams {
  const title = selectionTitle(args);
  const internalId = option(args, "meeting-id") || (looksLikeMeetingId(title) ? title : undefined);
  if (internalId) return new URLSearchParams({ meetingId: internalId });
  return buildSelectorParams(args, "Meeting");
}

const INCLUDE_ALIASES = new Map<string, MeetingInclude>([
  ["summary", "summary"],
  ["transcript", "transcript"],
  ["recording", "recordings"],
  ["recordings", "recordings"],
  ["whiteboard", "whiteboard_pdf"],
  ["whiteboard_pdf", "whiteboard_pdf"],
]);

export function normalizeMeetingIncludes(values: readonly string[]): MeetingInclude[] {
  const kinds = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (kinds.length === 0) {
    throw new Error("--include requires at least one of: summary, transcript, recordings, whiteboard");
  }
  return [...new Set(kinds.map((value) => {
    const normalized = INCLUDE_ALIASES.get(value.toLowerCase());
    if (!normalized) throw new Error(`Unknown Meeting content: ${value}`);
    return normalized;
  }))];
}

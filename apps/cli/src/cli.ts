import { readFile } from "node:fs/promises";

import {
  MAX_PAGINATION_PAGES,
  parseResponse,
  validate,
  publicApiErrorSchema,
  publicApiMeResponseSchema,
  publicApiTargetsResponseSchema,
  publicScheduleCancelResponseSchema,
  publicScheduleCreateResponseSchema,
  publicScheduleListResponseSchema,
  publicScheduleResponseSchema,
  publicScheduleUpdateResponseSchema,
  type ApiRequest,
  type ApiSchedule,
} from "./api.ts";
import {
  COMMAND_SPECS,
  flag,
  isCommandName,
  option,
  optionList,
  parseArgs,
  requiredOption,
  type ParsedArgs,
} from "./args.ts";
import { CLOUD_API_URL, CONFIG_PATH, readConfig, saveToken } from "./config.ts";
import { CliError, errorCode, errorMessage } from "./errors.ts";
import { commandHelp, globalHelp } from "./help.ts";
import { publicRetrievedMeeting, publicSchedule, publicSearchResults } from "./output.ts";
import { parseTranscriptLimit, retrieveMeeting } from "./retrieval.ts";
import {
  buildSelectorParams,
  looksLikeScheduleId,
  normalizeMeetingIncludes,
  selectionTitle,
  type MeetingInclude,
} from "./selectors.ts";
import {
  assertTimeZone,
  localTimeZone,
  minutesBetween,
  parseDurationMinutes,
  wallClockToIso,
} from "./time.ts";

const REQUEST_TIMEOUT_MS = 30_000;

type TimeZoneSource = "option" | "environment" | "account" | "machine";

interface TimeZoneChoice {
  timeZone: string;
  source: TimeZoneSource;
  warning?: string;
}

const request: ApiRequest = async (path, init = {}) => {
  const config = await readConfig();
  const headers = new Headers({
    Authorization: `Bearer ${config.token}`,
    Accept: "application/json",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
  });
  // A caller's own headers take precedence over the defaults above.
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "TimeoutError") {
      throw new Error(`Orb Meet API did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds`);
    }
    const nested = cause instanceof Error && cause.cause instanceof Error
      ? cause.cause.message
      : undefined;
    const detail = nested
      ?? (cause instanceof Error ? cause.message : undefined)
      ?? (cause == null ? "unknown network error" : String(cause));
    throw new Error(`Could not reach ${config.url} (${detail})`);
  }
  let result: unknown;
  try {
    result = JSON.parse(await response.text());
  } catch {
    result = undefined;
  }
  if (!response.ok) {
    const error = readApiError(result);
    throw new CliError(error.message ?? `Orb Meet API returned ${response.status}`, error);
  }
  if (result === undefined) {
    throw new Error(`Orb Meet API returned a response that is not JSON (status ${response.status})`);
  }
  return result;
};

async function scheduleTimeZone(args: ParsedArgs): Promise<TimeZoneChoice> {
  const explicit = option(args, "timezone");
  if (explicit) {
    return { timeZone: assertTimeZone(explicit, "--timezone"), source: "option" };
  }
  const environment = process.env.ORBMEET_TIMEZONE;
  if (environment) {
    return {
      timeZone: assertTimeZone(environment, "ORBMEET_TIMEZONE"),
      source: "environment",
    };
  }
  const me = parseResponse(publicApiMeResponseSchema, await request("/api/v1/me")).data;
  const homeTimeZone = me.user?.timeZone;
  if (homeTimeZone) {
    return {
      timeZone: assertTimeZone(homeTimeZone, "Account home time zone"),
      source: "account",
    };
  }
  const timeZone = localTimeZone();
  return {
    timeZone,
    source: "machine",
    warning: "No account home time zone is set; this schedule used the machine time zone. Set one in Orb Meet Settings, pass --timezone, or set ORBMEET_TIMEZONE.",
  };
}

/**
 * Read the documented `{ error: { code, message, details } }` failure body.
 * Contract-conforming bodies go through the shared error schema; anything
 * else (a gateway page that happens to parse, an older deployment) still
 * contributes whatever readable fields it has instead of being discarded.
 */
function readApiError(result: unknown): { message?: string; code?: string; details?: unknown } {
  const parsed = validate(publicApiErrorSchema, result);
  if (parsed.ok) {
    const { message, code, details } = parsed.value.error;
    return { message, code, details };
  }
  if (typeof result !== "object" || result === null || !("error" in result)) return {};
  const { error } = result;
  if (typeof error !== "object" || error === null) return {};
  const { message, code, details } = error as Record<string, unknown>;
  return {
    message: typeof message === "string" && message ? message : undefined,
    code: typeof code === "string" ? code : undefined,
    details,
  };
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function emitResult(args: ParsedArgs, raw: unknown, value: unknown): void {
  emit(flag(args, "raw") ? raw : value);
}


async function retrieveAllSchedules(): Promise<{ raw: unknown; schedules: ApiSchedule[] }> {
  const schedules: ApiSchedule[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let firstResult: unknown = null;
  let pages = 0;
  do {
    if (++pages > MAX_PAGINATION_PAGES) {
      throw new Error(
        `Schedule pagination did not finish within ${MAX_PAGINATION_PAGES} pages; aborting`,
      );
    }
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const result = await request(`/api/v1/schedules/${suffix}`);
    firstResult ??= result;
    const page = parseResponse(publicScheduleListResponseSchema, result);
    schedules.push(...page.data);
    const nextCursor = page.nextCursor || null;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new Error("Schedule pagination entered a cursor cycle; aborting to avoid an infinite loop");
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return {
    raw: { ...(firstResult as Record<string, unknown>), data: schedules, nextCursor: null },
    schedules,
  };
}

async function resolveSchedule(
  args: ParsedArgs,
  { includeCanceled = false }: { includeCanceled?: boolean } = {},
): Promise<ApiSchedule> {
  const titleOrId = selectionTitle(args);
  if (looksLikeScheduleId(titleOrId)) {
    const query = includeCanceled ? "?includeCanceled=true" : "";
    const result = await request(`/api/v1/schedules/${encodeURIComponent(titleOrId)}${query}`);
    return parseResponse(publicScheduleResponseSchema, result).data;
  }
  const params = buildSelectorParams(args, "schedule");
  if (includeCanceled) params.set("includeCanceled", "true");
  const result = await request(`/api/v1/schedules/?${params.toString()}`);
  return parseResponse(publicScheduleResponseSchema, result).data;
}

/** The fields every schedule-shaped response carries for summarizing. */
type ScheduleSummarySource = Pick<
  ApiSchedule,
  "id" | "title" | "startsAt" | "endsAt" | "timeZone"
> & { spaceName?: string | null };

function scheduleSummary(schedule: ScheduleSummarySource) {
  return {
    id: schedule.id,
    title: schedule.title,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    timeZone: schedule.timeZone,
    space: schedule.spaceName || undefined,
  };
}

const MEETING_COMMAND_INCLUDES = {
  meeting: [],
  summary: ["summary"],
  transcript: ["transcript"],
  recording: ["recordings"],
  recordings: ["recordings"],
  whiteboard: ["whiteboard_pdf"],
} as const satisfies Record<string, readonly MeetingInclude[]>;

type MeetingCommand = keyof typeof MEETING_COMMAND_INCLUDES;

function isMeetingCommand(command: string): command is MeetingCommand {
  return Object.hasOwn(MEETING_COMMAND_INCLUDES, command);
}

/**
 * Find the package manifest by walking up from this module. The published
 * build nests sources one directory deeper than the repository does, so a
 * fixed relative path would only be correct in one of the two layouts.
 */
async function readManifest(): Promise<{ version?: string }> {
  let directory = new URL("./", import.meta.url);
  for (let depth = 0; depth < 4; depth++) {
    try {
      return JSON.parse(await readFile(new URL("package.json", directory), "utf8"));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      directory = new URL("../", directory);
    }
  }
  throw new Error("Could not locate the orbmeet package manifest");
}

async function version(): Promise<void> {
  emit({ name: "orbmeet", version: (await readManifest()).version });
}

async function readConfigureToken(args: ParsedArgs): Promise<string> {
  const tokenFile = option(args, "token-file");
  if (tokenFile) return readFile(tokenFile, "utf8");
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const piped = Buffer.concat(chunks).toString("utf8");
    if (piped.trim()) return piped;
  }
  if (process.env.ORBMEET_TOKEN) return process.env.ORBMEET_TOKEN;
  throw new Error(
    "Provide the token on stdin, through ORBMEET_TOKEN, or with --token-file. Tokens are not accepted on the command line.",
  );
}

function requestsCommandHelp(argv: readonly string[]): boolean {
  for (const token of argv.slice(1)) {
    if (token === "--") return false;
    if (token === "--help" || token === "-h") return true;
  }
  return false;
}

async function main(argv: readonly string[]): Promise<void> {
  const [command] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(globalHelp());
    return;
  }
  if (command === "help") {
    process.stdout.write(argv[1] ? commandHelp(argv[1]) : globalHelp());
    return;
  }
  if (command === "--version") return version();
  if (!isCommandName(command)) throw new Error(`Unknown command: ${command}. Run: orbmeet help`);
  const spec = COMMAND_SPECS[command];
  // Help is terminal behavior, so malformed options before it must not prevent
  // users from reaching the documentation. Stop at `--`: everything after the
  // end-of-options marker is literal positional input.
  if (requestsCommandHelp(argv)) {
    process.stdout.write(commandHelp(command));
    return;
  }
  const args = parseArgs(argv, spec);

  if (command === "version") return version();
  if (command === "configure") {
    await saveToken(await readConfigureToken(args));
    return emit({ configured: true, cloud: CLOUD_API_URL, configPath: CONFIG_PATH });
  }
  if (command === "whoami") {
    const result = await request("/api/v1/me");
    const data = parseResponse(publicApiMeResponseSchema, result).data;
    const machineTimeZone = localTimeZone();
    const environmentTimeZone = process.env.ORBMEET_TIMEZONE
      ? assertTimeZone(process.env.ORBMEET_TIMEZONE, "ORBMEET_TIMEZONE")
      : null;
    const effectiveTimeZone = environmentTimeZone ?? data.user.timeZone ?? machineTimeZone;
    const timeZoneSource: Exclude<TimeZoneSource, "option"> = environmentTimeZone
      ? "environment"
      : data.user.timeZone
        ? "account"
        : "machine";
    return emitResult(args, result, {
      user: data.user,
      scopes: data.scopes,
      serverTime: data.serverTime,
      homeTimeZone: data.user.timeZone,
      machineTimeZone,
      // Kept for scripts written against the initial whoami output.
      localTimeZone: machineTimeZone,
      effectiveTimeZone,
      timeZoneSource,
    });
  }
  if (command === "search") {
    const query = args.positional.slice(1).join(" ").trim();
    if (!query) throw new Error("Usage: orbmeet search <name, email, or Space>");
    const result = await request(`/api/v1/targets?q=${encodeURIComponent(query)}`);
    return emitResult(
      args,
      result,
      publicSearchResults(parseResponse(publicApiTargetsResponseSchema, result).data),
    );
  }
  if (command === "schedules") {
    const { raw, schedules } = await retrieveAllSchedules();
    return emitResult(args, raw, { meetings: schedules.map(publicSchedule) });
  }
  if (command === "schedule") {
    const spaceName = option(args, "space") || undefined;
    const spaceId = option(args, "space-id");
    if (spaceName && spaceId) throw new Error("Provide either --space or --space-id, not both");
    const timeZoneChoice = await scheduleTimeZone(args);
    const timeZone = timeZoneChoice.timeZone;
    const body = {
      title: option(args, "title") || undefined,
      startsAt: wallClockToIso(requiredOption(args, "at"), timeZone),
      timeZone,
      durationMinutes: parseDurationMinutes(option(args, "duration"), 30),
      attendees: optionList(args, "email").map((email) => ({ email })),
      contactIds: optionList(args, "contact"),
      contactNames: optionList(args, "with"),
      spaceName,
      spaceId,
      joinPolicy: flag(args, "approval") ? "approval_required" : "open",
    };
    const idempotencyKey = option(args, "idempotency-key") || crypto.randomUUID();
    const result = await request("/api/v1/schedules/", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    });
    const data = parseResponse(publicScheduleCreateResponseSchema, result).data;
    return emitResult(args, result, {
      status: "scheduled",
      timeZoneSource: timeZoneChoice.source,
      ...(timeZoneChoice.warning ? { warning: timeZoneChoice.warning } : {}),
      meeting: {
        ...scheduleSummary(data),
        attendeeCount: data.attendeeCount,
        joinUrl: data.code ? `${CLOUD_API_URL}/${data.code}` : undefined,
      },
    });
  }
  if (command === "reschedule") {
    const at = requiredOption(args, "at");
    const schedule = await resolveSchedule(args);
    const timeZone = option(args, "timezone") || schedule.timeZone;
    const change = {
      startsAt: wallClockToIso(at, timeZone),
      timeZone,
      durationMinutes: parseDurationMinutes(
        option(args, "duration"),
        minutesBetween(schedule.startsAt, schedule.endsAt),
      ),
    };
    if (flag(args, "dry-run")) {
      return emitResult(args, { data: schedule }, {
        status: "dry_run",
        action: "reschedule",
        meeting: scheduleSummary(schedule),
        change,
      });
    }
    const result = await request(`/api/v1/schedules/${encodeURIComponent(schedule.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: schedule.revision, ...change }),
    });
    const data = parseResponse(publicScheduleUpdateResponseSchema, result).data;
    return emitResult(args, result, {
      status: "rescheduled",
      meeting: {
        ...scheduleSummary(schedule),
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        timeZone: data.timeZone,
      },
    });
  }
  if (command === "cancel") {
    const schedule = await resolveSchedule(args, { includeCanceled: true });
    if (flag(args, "dry-run")) {
      return emitResult(args, { data: schedule }, {
        status: "dry_run",
        action: "cancel",
        meeting: scheduleSummary(schedule),
      });
    }
    const body = {
      expectedRevision: schedule.revision,
      reason: option(args, "reason") || undefined,
    };
    const result = await request(`/api/v1/schedules/${encodeURIComponent(schedule.id)}`, {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    const data = parseResponse(publicScheduleCancelResponseSchema, result).data;
    return emitResult(args, result, {
      status: data.alreadyCanceled ? "already_canceled" : "canceled",
      meeting: scheduleSummary(schedule),
    });
  }
  if (isMeetingCommand(command) || command === "retrieve") {
    const requested = optionList(args, "include");
    const includes: readonly MeetingInclude[] = command === "retrieve"
      ? normalizeMeetingIncludes(requested.length > 0 ? requested : ["summary"])
      : MEETING_COMMAND_INCLUDES[command];
    const maxSegments = parseTranscriptLimit(option(args, "transcript-limit"));
    const result = await retrieveMeeting(request, args, includes, maxSegments);
    return emitResult(args, result.raw, publicRetrievedMeeting(result.data));
  }
  // `command` is `never` here: every entry in COMMAND_SPECS is handled above,
  // so adding a command without a branch fails to compile.
  const unhandled: never = command;
  throw new Error(`Unknown command: ${String(unhandled)}. Run: orbmeet help`);
}

export function run(argv: readonly string[]): Promise<void> {
  return main(argv).catch((error: unknown) => {
    process.exitCode = 1;
    const details = error instanceof CliError ? error.details : undefined;
    process.stderr.write(`${JSON.stringify({
      error: {
        code: (error instanceof CliError ? error.code : errorCode(error)) || "CLI_ERROR",
        message: errorMessage(error),
        ...(details ? { details } : {}),
      },
    }, null, 2)}\n`);
  });
}

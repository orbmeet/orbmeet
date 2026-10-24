// Response handling for every command. Wire shapes are not redeclared here:
// payloads are parsed with the shared public API schemas
// (packages/public-api-contract/src/responses.ts) and the types below are
// derived from those schemas, so the CLI and the server cannot drift.

import type {
  PublicApiTargetsResponse,
  PublicMeetingResponse,
  PublicSchedule,
  PublicScheduleAttendee,
  PublicTranscript,
} from "@orbmeet/public-api-contract";

/** Performs an authenticated request and returns the parsed JSON body. */
export type ApiRequest = (path: string, init?: RequestInit) => Promise<unknown>;
export type ApiTargets = PublicApiTargetsResponse["data"];
export type ApiSchedule = PublicSchedule;
export type ApiAttendee = PublicScheduleAttendee;

/**
 * The meeting payload with its transcript section re-typed: the envelope
 * schema leaves `transcript` unknown, and `retrieveMeeting` validates every
 * page against the shared transcript schema before handing the payload on.
 * `undefined` means the section was absent (JSON never produces undefined
 * values), `null` that the server explicitly marked it unavailable.
 */
export type RetrievedMeeting = PublicMeetingResponse["data"] & {
  transcript?: PublicTranscript | null;
};

/**
 * The Standard Schema surface (https://standardschema.dev) the shared contract
 * schemas implement. The CLI validates through it, so it depends on the
 * contract rather than on whichever library defines it.
 */
export interface StandardSchema<T> {
  readonly "~standard": {
    readonly validate: (value: unknown) =>
      | { readonly value: T; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> }
      | Promise<unknown>;
  };
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ReadonlyArray<{ readonly message: string }> };

/** Validate synchronously; every contract schema is synchronous. */
export function validate<T>(schema: StandardSchema<T>, value: unknown): ValidationResult<T> {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) throw new TypeError("Contract schemas must validate synchronously");
  return result.issues ? { ok: false, issues: result.issues } : { ok: true, value: result.value };
}

/**
 * Hard ceiling on pages for every paginated command.
 *
 * Cursor-cycle detection only catches a server that repeats itself. One that
 * hands back a *fresh* cursor every time — a bug, or a host answering something
 * other than this API — makes the loop run until the process is killed, with
 * `seenCursors` growing the whole time. A list that needs more pages than this
 * is not a list anyone is waiting on the command line for.
 */
export const MAX_PAGINATION_PAGES = 100;

const UNEXPECTED = "Orb Meet API returned an unexpected success response";

/**
 * Validate a success envelope against a shared schema, collapsing schema
 * failures into the CLI's stable unexpected-response error (the cause keeps
 * the validation issues for debugging).
 */
export function parseResponse<T>(schema: StandardSchema<T>, result: unknown, message = UNEXPECTED): T {
  const parsed = validate(schema, result);
  if (!parsed.ok) throw new Error(message, { cause: parsed.issues });
  return parsed.value;
}

// Re-exported so every CLI module takes the shared contract through this
// module instead of importing the package ad hoc.
export {
  publicApiErrorSchema,
  publicApiMeResponseSchema,
  publicApiTargetsResponseSchema,
  publicMeetingResponseSchema,
  publicMeetingTranscriptPageResponseSchema,
  publicScheduleCreateResponseSchema,
  publicScheduleCancelResponseSchema,
  publicScheduleListResponseSchema,
  publicScheduleResponseSchema,
  publicScheduleUpdateResponseSchema,
  publicTranscriptSchema,
} from "@orbmeet/public-api-contract";

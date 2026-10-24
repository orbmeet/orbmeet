import * as v from "valibot";
import { integerSchema } from "@orbmeet/public-api-contract/fields";
import type { MeetingEntryDiagnosticEvent } from "./diagnostics";

/**
 * The wire contract for meeting-entry diagnostics, shared by the emitter and
 * the ingest endpoint.
 *
 * It exists because the two halves had drifted apart silently. The client
 * computed exactly what `issue.md` asked for — `microphoneReason`,
 * `audioGranted`, `audioErrorName` and the rest of the capture classification —
 * and shipped it; the endpoint declared six fields on a plain `z.object`, which
 * strips unknown keys. `safeParse` then *succeeded*, so there was no error and
 * no signal, and every diagnostic field was discarded one line before the log
 * call. The information the incident was filed to obtain was computed,
 * serialized, transmitted and thrown away.
 *
 * The stripping was deliberate — it stopped attacker-controlled fields reaching
 * a log line verbatim — so the fix keeps that guarantee rather than passing
 * unknown keys through. Detail fields are now *accepted and bounded*: primitives and
 * short string lists only, every string truncated, the field count capped. An
 * object, a function or a deeply nested payload still cannot reach the log.
 */

/** Longest string kept for any single diagnostic value. */
export const MAX_DIAGNOSTIC_VALUE_LENGTH = 200;
/** Longest key accepted for a detail field. */
export const MAX_DIAGNOSTIC_KEY_LENGTH = 64;
/** Most entries kept in a list-valued field (e.g. audio degradation reasons). */
export const MAX_DIAGNOSTIC_LIST_LENGTH = 12;
/** Most detail fields kept on one event, so a log line cannot be flooded. */
export const MAX_DIAGNOSTIC_FIELDS = 32;

/**
 * The events that report something going wrong for the participant. They are
 * logged as warnings; every other event is the ordinary course of joining and
 * staying in a meeting, logged as information.
 */
export const PROBLEM_DIAGNOSTIC_EVENTS: ReadonlySet<string> = new Set([
  "device_probe_failed",
  "device_probe_timeout",
  "join_rpc_timeout",
  "livekit_connect_timeout",
  "livekit_reconnecting",
  "livekit_error",
  "media_device_failure",
  "media_devices_error",
  "initial_microphone_publish_failed",
  "local_mic_failure",
  "local_mic_interrupted",
  "local_mic_resume_failed",
  "remote_track_subscription_failed",
] satisfies MeetingEntryDiagnosticEvent[]);

/**
 * What a diagnostic field may hold. Deliberately narrow: this is telemetry, and
 * anything that is not a scalar or a short list of scalars is a sign the call
 * site meant to summarise something and did not.
 */
export type DiagnosticValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly string[];

/** The payload half of a diagnostic event, before the envelope is added. */
export type DiagnosticDetail = Readonly<Record<string, DiagnosticValue>>;

const truncate = (value: string) => value.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH);

/**
 * One value coerced onto the contract.
 *
 * Total by construction: anything it will not carry falls back to `undefined`
 * rather than failing, so one malformed field can never cost the whole event.
 * That matters more here than strictness — an event that fails to parse is an
 * event the incident review does not have.
 */
const diagnosticValueSchema = v.fallback(
  v.optional(v.union([
    v.null(),
    v.boolean(),
    v.pipe(v.number(), v.finite()),
    v.pipe(v.string(), v.transform(truncate)),
    v.pipe(
      v.array(v.unknown()),
      v.transform((list) =>
        list
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, MAX_DIAGNOSTIC_LIST_LENGTH)
          .map(truncate)),
    ),
  ])),
  undefined,
);

export function normaliseDiagnosticValue(value: unknown): DiagnosticValue {
  return v.parse(diagnosticValueSchema, value);
}

/**
 * Normalise a whole detail object: drop what will not travel, cap the rest.
 * Key order is the caller's, so the fields a call site considered most
 * important are the ones that survive the cap.
 */
export function normaliseDiagnosticDetail(
  input: unknown,
): Record<string, Exclude<DiagnosticValue, undefined>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }

  const output: Record<string, Exclude<DiagnosticValue, undefined>> = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(input)) {
    if (kept >= MAX_DIAGNOSTIC_FIELDS) break;
    if (key.length === 0 || key.length > MAX_DIAGNOSTIC_KEY_LENGTH) continue;
    const value = normaliseDiagnosticValue(raw);
    if (value === undefined) continue;
    output[key] = value;
    kept += 1;
  }
  return output;
}

function optionalText(max: number) {
  return v.optional(v.pipe(v.string(), v.maxLength(max)));
}

function optionalNumber(max: number) {
  return v.optional(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(max)));
}

/** Browser context every event carries. */
const browserDiagnosticSchema = v.strictObject({
  userAgent: optionalText(512),
  platform: optionalText(100),
  maxTouchPoints: v.optional(integerSchema(0, 100)),
  effectiveType: optionalText(32),
  downlink: optionalNumber(100_000),
  rtt: optionalNumber(3_600_000),
});

/**
 * One posted diagnostic: the envelope, with every other key as detail.
 *
 * Only an unusable envelope rejects the event — an event with no name is not a
 * diagnostic, and a browser snapshot that does not fit its shape is forged, not
 * damaged. A descriptive envelope field that does not fit is dropped, and the
 * detail is normalised rather than validated, so every other shape is salvaged.
 */
const clientDiagnosticSchema = v.pipe(
  v.objectWithRest(
    {
      event: v.pipe(v.string(), v.nonEmpty(), v.maxLength(100)),
      ts: v.fallback(optionalText(64), undefined),
      flowId: v.fallback(optionalText(100), undefined),
      stage: v.fallback(optionalText(100), undefined),
      elapsedMs: v.fallback(v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))), undefined),
      // What joins this event to the rest of the record: the browser tab, and
      // once joined, the meeting and the connection (LiveKit's identity ends
      // with it).
      tabId: v.fallback(optionalText(64), undefined),
      meetingId: v.fallback(optionalText(100), undefined),
      connectionId: v.fallback(optionalText(100), undefined),
      browser: v.optional(browserDiagnosticSchema),
    },
    v.unknown(),
  ),
  v.transform(({ event, ts, flowId, stage, elapsedMs, tabId, meetingId, connectionId, browser, ...detail }) => ({
    event,
    ts,
    flowId,
    stage,
    elapsedMs,
    tabId,
    meetingId,
    connectionId,
    browser,
    detail: normaliseDiagnosticDetail(detail),
  })),
);

export type ParsedClientDiagnostic = v.InferOutput<typeof clientDiagnosticSchema>;

/** Parse one posted diagnostic, or `null` when its envelope is unusable. */
export function parseClientDiagnostic(body: unknown): ParsedClientDiagnostic | null {
  const result = v.safeParse(clientDiagnosticSchema, body);
  return result.success ? result.output : null;
}

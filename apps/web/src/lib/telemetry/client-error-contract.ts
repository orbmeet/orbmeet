import * as v from "valibot";

/**
 * The wire contract for an error the browser reports, shared by the reporter
 * and the ingest endpoint. Every field is text the page wrote about itself, so
 * each is bounded: an over-long value is cut, never a reason to lose the
 * report, and a field that is not text is dropped.
 */

export const CLIENT_ERROR_ENDPOINT = "/api/diagnostics/client-error";

const CLIENT_ERROR_SOURCES = ["error", "unhandledrejection", "boundary"] as const;
export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

function text(max: number) {
  return v.fallback(
    v.optional(v.pipe(v.string(), v.transform((value) => value.slice(0, max)))),
    undefined,
  );
}

const clientErrorSchema = v.object({
  source: v.picklist(CLIENT_ERROR_SOURCES),
  /** Which error boundary caught it, for `boundary`. */
  boundary: text(64),
  name: text(100),
  message: text(1_000),
  stack: text(8_000),
  componentStack: text(4_000),
  /** The route's id (`/join/$token`), never its URL: a URL can carry a secret. */
  route: text(200),
  tabId: text(64),
  ts: text(64),
  userAgent: text(512),
});

export type ClientErrorReport = v.InferOutput<typeof clientErrorSchema>;

/** Parse one posted report, or `null` when it does not say where it came from. */
export function parseClientErrorReport(body: unknown): ClientErrorReport | null {
  const result = v.safeParse(clientErrorSchema, body);
  return result.success ? result.output : null;
}

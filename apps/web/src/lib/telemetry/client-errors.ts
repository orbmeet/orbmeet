import { getServerErrorStatusCode } from "@/lib/error-inspection";
import { CLIENT_ERROR_ENDPOINT, type ClientErrorReport, type ClientErrorSource } from "./client-error-contract";
import { postTelemetry, telemetryTabId } from "./outbox";

// Errors the page meets, reported to the Worker: whatever escapes to the
// window, and whatever an error boundary catches. Each distinct error once
// per page, and only so many, so a loop that throws cannot flood the endpoint.
// Development reports nothing: the console there is the report.

const MAX_REPORTS_PER_PAGE = 20;

let readRoute: () => string | undefined = () => undefined;
const reported = new Set<string>();

/** Where the route id comes from: the router, once the app has one. */
export function setClientErrorRoute(read: () => string | undefined): void {
  readRoute = read;
}

function reportClientError(
  source: ClientErrorSource,
  error: unknown,
  detail: { boundary?: string; componentStack?: string } = {},
): void {
  if (import.meta.env.DEV || typeof window === "undefined") return;
  const { name, message, stack } = describeError(error);
  const key = `${source}\n${name}\n${message}`;
  if (reported.has(key) || reported.size >= MAX_REPORTS_PER_PAGE) return;
  reported.add(key);

  const report: ClientErrorReport = {
    source,
    ...detail,
    name,
    message,
    stack,
    route: readRoute(),
    tabId: telemetryTabId(),
    ts: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };
  postTelemetry(CLIENT_ERROR_ENDPOINT, report);
}

/**
 * What an error boundary caught. An error the server answered with is the
 * server's to log, and it has: a refusal is expected, and a failure was
 * logged where it happened.
 */
export function reportBoundaryError(boundary: string, error: unknown, componentStack?: string | null): void {
  if (getServerErrorStatusCode(error) !== undefined) return;
  reportClientError("boundary", error, { boundary, componentStack: componentStack ?? undefined });
}

/** Report what escapes to the window: uncaught errors and unhandled rejections. */
export function installClientErrorReporting(): () => void {
  const onError = (event: ErrorEvent) => {
    // A cross-origin script's error arrives with nothing but this message.
    if (!event.error && event.message === "Script error.") return;
    reportClientError("error", event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => reportClientError("unhandledrejection", event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

function describeError(error: unknown): { name?: string; message?: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

// What the browser tells the Worker about itself: meeting diagnostics and
// errors. A report is sent at once; one that cannot reach the Worker (the
// network is down, the phone is between networks) waits in this tab's
// sessionStorage and goes with the next report that does, or when the page is
// online, visible or loaded again. A reload therefore delivers what the page
// before it could not. A report the Worker answers is never sent again, even
// when it refused it: a refusal would only repeat.

const OUTBOX_KEY = "orbmeet:telemetry-outbox";
const TAB_KEY = "orbmeet:telemetry-tab";
/** Older reports give way to newer ones past this many. */
const MAX_QUEUED = 100;

interface Report {
  endpoint: string;
  body: string;
}

let memoryTabId: string | undefined;
let flushing: Promise<void> | null = null;

/** This tab's id: the same across reloads, so its reports join up. */
export function telemetryTabId(): string {
  try {
    const stored = sessionStorage.getItem(TAB_KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    sessionStorage.setItem(TAB_KEY, id);
    return id;
  } catch {
    memoryTabId ??= crypto.randomUUID();
    return memoryTabId;
  }
}

/** Send one report to `endpoint`, keeping it for later if the Worker cannot be reached. */
export function postTelemetry(endpoint: string, body: unknown): void {
  if (typeof window === "undefined") return;
  const report = { endpoint, body: JSON.stringify(body) };
  void deliver(report).then((delivered) => {
    if (delivered) void flushTelemetry();
    else enqueue(report);
  });
}

/** Send what is waiting, oldest first, stopping at the first that still cannot go. */
export function flushTelemetry(): Promise<void> {
  // `finally` runs after this assignment even when there is nothing to send.
  flushing ??= drain().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function drain(): Promise<void> {
  for (let report = peek(); report; report = peek()) {
    if (!(await deliver(report))) return;
    shift();
  }
}

/** Resend waiting reports whenever the page may be able to: once now, then on each chance. */
export function installTelemetryOutbox(): () => void {
  const flush = () => void flushTelemetry();
  const flushWhenVisible = () => {
    if (document.visibilityState === "visible") flush();
  };
  window.addEventListener("online", flush);
  window.addEventListener("pageshow", flush);
  document.addEventListener("visibilitychange", flushWhenVisible);
  flush();
  return () => {
    window.removeEventListener("online", flush);
    window.removeEventListener("pageshow", flush);
    document.removeEventListener("visibilitychange", flushWhenVisible);
  };
}

async function deliver({ endpoint, body }: Report): Promise<boolean> {
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // Outlives the page, so a report made as it closes still leaves.
      keepalive: true,
    });
    return true;
  } catch {
    return false;
  }
}

function read(): Report[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(OUTBOX_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isReport) : [];
  } catch {
    return [];
  }
}

function write(reports: Report[]): void {
  try {
    if (reports.length === 0) sessionStorage.removeItem(OUTBOX_KEY);
    else sessionStorage.setItem(OUTBOX_KEY, JSON.stringify(reports.slice(-MAX_QUEUED)));
  } catch {
    // Storage is full or refused: the report is lost, as it would have been.
  }
}

function enqueue(report: Report): void {
  write([...read(), report]);
}

function peek(): Report | undefined {
  return read()[0];
}

function shift(): void {
  write(read().slice(1));
}

function isReport(value: unknown): value is Report {
  return typeof value === "object" && value !== null
    && typeof (value as Report).endpoint === "string" && typeof (value as Report).body === "string";
}

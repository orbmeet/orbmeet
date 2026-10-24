// Structured logging shared by every runtime: the Worker, the browser and the
// Node services. One serializer and one redaction rule, so no runtime logs a
// secret another would have hidden, and no log call can be the thing that
// fails.

export type LogLevel = "error" | "warn" | "info";

export const REDACTED = "[REDACTED]";

/**
 * Matched against object *keys* only (never values), so the cost is O(keys)
 * rather than O(bytes).
 */
export const SENSITIVE_KEY_RE =
  /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|set-cookie|otp|code[_-]?verifier|client[_-]?secret|signature|hmac|private[-_]?key|bearer|jwt|csrf|xsrf)/i;

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2 };

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

export interface LoggerOptions {
  /** The least severe level written; `error` always is. */
  minLevel: LogLevel;
  /** Where a finished line goes; one JSON object per line by default. */
  write?: (level: LogLevel, line: string, entry: Record<string, unknown>) => void;
  /**
   * Fields every line carries, read when the line is written: the request or
   * job it belongs to. A call's own fields win over them.
   */
  context?: () => Record<string, unknown> | undefined;
}

/**
 * A logger writing `{ ts, level, msg, ...context, ...fields, args }` lines. A
 * first argument that is a plain object is merged into the line; the rest go
 * under `args`. Errors keep their stacks and causes, cycles are cut, and
 * sensitive keys are redacted before anything is serialized. A call below
 * `minLevel` returns before building anything.
 */
export function createLogger({ minLevel, write = writeToConsole, context }: LoggerOptions): Logger {
  const min = LEVEL_RANK[minLevel];
  const log = (level: LogLevel, message: string, args: unknown[]) => {
    if (LEVEL_RANK[level] > min) return;
    const entry = logEntry(level, message, args, context?.());
    write(level, stringifyEntry(entry), entry);
  };
  return {
    error: (message, ...args) => log("error", message, args),
    warn: (message, ...args) => log("warn", message, args),
    info: (message, ...args) => log("info", message, args),
  };
}

function writeToConsole(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function logEntry(
  level: LogLevel,
  message: string,
  args: readonly unknown[],
  context?: Record<string, unknown>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, msg: message };
  if (context) Object.assign(entry, serializeLogValue(context));
  let rest = args;
  if (rest.length > 0 && isPlainObject(rest[0])) {
    Object.assign(entry, serializeLogValue(rest[0]));
    rest = rest.slice(1);
  }
  if (rest.length > 0) entry.args = rest.map((value) => serializeLogValue(value));
  return entry;
}

function stringifyEntry(entry: Record<string, unknown>): string {
  // `serializeLogValue` already cuts cycles, so this only catches the exotic
  // remainder: a throwing getter, a BigInt, a value with a hostile `toJSON`.
  try {
    return JSON.stringify(entry);
  } catch {
    return JSON.stringify({ ts: entry.ts, level: entry.level, msg: entry.msg, args: "[Unserializable]" });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Error);
}

const CYCLE = "[Circular]";
const TRUNCATED = "[Truncated]";
const MAX_SERIALIZE_DEPTH = 12;

/**
 * A value made safe to log: errors as plain objects, cycles cut, sensitive
 * keys redacted. An error keeps its string `code`, its `cause` and an
 * `AggregateError`'s `errors`, so a wrapper never hides what went wrong.
 */
export function serializeLogValue(
  value: unknown,
  keyHint?: string,
  seen: Set<object> = new Set(),
  depth = 0,
): unknown {
  if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) return REDACTED;
  if (!(value instanceof Error) && !Array.isArray(value) && !isPlainObject(value)) return value;
  if (depth >= MAX_SERIALIZE_DEPTH) return TRUNCATED;
  // Only the current path is tracked, so a value that legitimately appears
  // twice in a tree still serializes twice; only a genuine cycle is cut.
  if (seen.has(value)) return CYCLE;
  seen.add(value);
  try {
    if (value instanceof Error) return serializeError(value, seen, depth);
    if (Array.isArray(value)) return value.map((item) => serializeLogValue(item, undefined, seen, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY_RE.test(key) ? REDACTED : serializeLogValue(item, key, seen, depth + 1),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

function serializeError(error: Error, seen: Set<object>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  const { code } = error as { code?: unknown };
  if (typeof code === "string") out.code = code;
  if (error.stack) out.stack = error.stack;
  if (error.cause !== undefined) out.cause = serializeLogValue(error.cause, undefined, seen, depth + 1);
  if (error instanceof AggregateError) out.errors = serializeLogValue(error.errors, undefined, seen, depth + 1);
  return out;
}

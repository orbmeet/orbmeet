import { sleep } from "@/lib/sleep";

/**
 * Read the row-changes count from a Drizzle `.run()` result.
 * Production and tests both use D1, which returns
 * `{ meta: { changes: number } }`.
 */
export function getRunChanges(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const r = result as Record<string, unknown>;
  const meta = r.meta;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    if (typeof m.changes === "number") return m.changes;
  }
  return 0;
}

/**
 * Every message in an error's `cause` chain, lowercased.
 *
 * Drizzle wraps every driver failure in a `DrizzleQueryError` whose own message
 * is always `Failed query: …`; the SQLite/D1 text these predicates match on sits
 * one level down in `cause`. The wrapping happens in the shared SQLite session
 * layer, so reading only the top-level message misses the D1 error.
 */
function dbErrorMessageChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  // Cause chains are short; the bound only guarantees termination on a cycle.
  for (let depth = 0; current != null && depth < 8; depth++) {
    if (current instanceof Error) {
      messages.push(current.message.toLowerCase());
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    messages.push(String(current).toLowerCase());
    break;
  }
  if (messages.length === 0) messages.push(String(error).toLowerCase());
  return messages;
}

function dbErrorMatches(error: unknown, needles: readonly string[]): boolean {
  return dbErrorMessageChain(error).some((message) =>
    needles.some((needle) => message.includes(needle)),
  );
}

/**
 * Best-effort detection of transient D1/runtime errors that are safe to retry.
 * See docs/d1/best-practices/retry-queries.md for representative patterns.
 */
export function isRetryableD1Error(error: unknown): boolean {
  return dbErrorMatches(error, [
    "network connection lost",
    "storage caused object to be reset",
    "reset because its code was updated",
  ]);
}

/**
 * A UNIQUE (or PRIMARY KEY) constraint violation, whatever driver raised it.
 *
 * D1 exposes no structured constraint code — its binding throws a plain `Error`
 * and Cloudflare's own guidance is to match the message text (see
 * docs/d1/observability/debug-d1). This is therefore the single place that
 * knows the wording, rather than every insert site restating it and drifting.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return dbErrorMatches(error, ["unique constraint failed", "sqlite_constraint_unique"]);
}

/**
 * Retry transient D1 failures with exponential backoff + jitter.
 *
 * D1 only recommends retrying idempotent queries, so the caller must assert
 * idempotency in the type. Non-idempotent writes are simply not wrapped.
 */
export async function withD1Retry<T>(
  operation: () => Promise<T>,
  options: { idempotent: true; maxAttempts?: number; baseDelayMs?: number },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }
  const baseDelayMs = options.baseDelayMs ?? 30;
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError("baseDelayMs must be finite and nonnegative");
  }
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableD1Error(error)) {
        throw error;
      }
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * (baseDelayMs + 1));
      await sleep(backoff + jitter);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

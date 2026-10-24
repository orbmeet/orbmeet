/**
 * Standard error shape from server functions
 */
export interface ServerFunctionError extends Error {
  code?: string;
  statusCode?: number;
}

function getErrorLikeMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

function getNestedServerErrorValue<T>(
  error: unknown,
  key: string,
  isExpectedType: (value: unknown) => value is T,
): T | undefined {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || (typeof current !== "object" && !(current instanceof Error))) {
      continue;
    }
    if (seen.has(current)) continue;
    seen.add(current);

    const record = current as Record<string, unknown>;
    const direct = record[key];
    if (isExpectedType(direct)) {
      return direct;
    }

    if ("data" in record) queue.push(record.data);
    if ("cause" in record) queue.push(record.cause);
    if ("error" in record) queue.push(record.error);
  }

  return undefined;
}

export function getServerErrorCode(error: unknown): string | undefined {
  return getNestedServerErrorValue(
    error,
    "code",
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function getServerErrorStatusCode(error: unknown): number | undefined {
  return getNestedServerErrorValue(
    error,
    "statusCode",
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

export function getServerErrorStringValue(error: unknown, key: string): string | undefined {
  return getNestedServerErrorValue(
    error,
    key,
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

/**
 * Type guard to check if error is a ServerFunctionError
 */
export function isServerError(error: unknown): error is ServerFunctionError {
  return error instanceof Error &&
    (typeof getServerErrorCode(error) === "string" ||
      typeof getServerErrorStatusCode(error) === "number");
}

/**
 * Safely get error message from unknown error
 */
export function getErrorMessage(error: unknown, fallback = "Something went wrong"): string {
  const message = getErrorLikeMessage(error);
  if (message) return message;
  return fallback;
}

/**
 * Present route errors without exposing unexpected server/runtime details.
 * Expected 4xx AppErrors are deliberately user-facing; unknown and 5xx errors
 * keep their diagnostic message in logs and receive a stable client fallback.
 */
export function getSafeRouteErrorMessage(
  error: unknown,
  fallback = "Something went wrong",
): string {
  const statusCode = getServerErrorStatusCode(error);
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return getErrorLikeMessage(error) || fallback;
  }
  return fallback;
}

/**
 * Message and stack for the development-only error overlay. Error boundaries
 * receive whatever was thrown, which is not necessarily an `Error`, so read
 * both fields defensively and return nothing when there is nothing to show.
 */
export function formatErrorDiagnostics(error: unknown): string | undefined {
  const message = getErrorLikeMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;
  if (!message) return stack;
  return stack ? `${message}\n${stack}` : message;
}

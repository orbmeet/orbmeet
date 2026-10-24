export class RequestBodyTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`Request body exceeds ${limitBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export class RequestBodyTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request body read timed out after ${timeoutMs}ms`);
    this.name = "RequestBodyTimeoutError";
  }
}

function readWithTimeout<T>(read: Promise<T>, timeoutMs: number, startedAt: number): Promise<T> {
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    throw new RequestBodyTimeoutError(timeoutMs);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    read,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new RequestBodyTimeoutError(timeoutMs)), remainingMs);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

/**
 * Reads a request body into memory while enforcing a strict byte limit even
 * when the sender omits or lies about Content-Length.
 */
export async function readRequestBodyBytes(
  request: Request,
  maxBytes: number,
  timeoutMs = 15_000,
): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }

  const stream = request.body;
  if (!stream) return new Uint8Array();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let shouldCancel = false;
  const startedAt = Date.now();

  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader.read(), timeoutMs, startedAt);
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        shouldCancel = true;
        throw new RequestBodyTooLargeError(maxBytes);
      }

      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError || err instanceof RequestBodyTimeoutError) {
      shouldCancel = true;
    }
    throw err;
  } finally {
    if (shouldCancel) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readRequestBodyText(
  request: Request,
  maxBytes: number,
  timeoutMs?: number,
): Promise<string> {
  const bytes = await readRequestBodyBytes(request, maxBytes, timeoutMs);
  return new TextDecoder().decode(bytes);
}

/**
 * Parse a request body that a handler is about to read properties off.
 *
 * `JSON.parse` accepts every JSON value, not just objects, so `null` — a
 * five-byte body — parsed cleanly and then threw a TypeError on the first
 * property access. Returning null for anything that is not a plain object lets
 * the handler answer 400 the way it does for malformed JSON.
 */
export function parseJsonObjectBody(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

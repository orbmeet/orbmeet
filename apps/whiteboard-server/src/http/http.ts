import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { Reply } from "./reply.ts";

export const MAX_HTTP_BODY_BYTES = 64 * 1024;
const HTTP_BODY_READ_TIMEOUT_MS = 30_000;

export interface StreamReadTimeouts {
  /** Maximum time to wait for the next body chunk. */
  idleMs: number;
  /** Maximum wall-clock time for the complete body. */
  totalMs: number;
}

/** A request header as one string, or null when absent. */
export function header(req: Pick<IncomingMessage, "headers">, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * The declared body size, or null when the header does not declare one.
 *
 * `parseInt` reads a prefix and stops: `"5x"`, `"5 000"` and `"0x1000"` all
 * came back as small numbers that passed the size check, and `"-1"` came back
 * negative. The actual byte count in `readBoundedJson` is what enforces the
 * limit, so none of that was a bypass — but a header this permissive is not
 * evidence of anything, and a value that is not a size should not be read as
 * one. Only a plain non-negative integer is an answer; anything else is
 * treated as "not declared" and left to the streaming count.
 */
export function getContentLength(req: Pick<IncomingMessage, "headers">): number | null {
  const value = header(req, "Content-Length")?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : null;
}

/**
 * Await one stream read with a disposable timer. A read still pending after a
 * timeout settles when the stream is destroyed or its connection closes.
 */
function withReadTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("read_timeout")), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Stream `body` while bounding both stalls and total request lifetime. Keeping
 * these limits separate lets a progressing upload survive a short default
 * request deadline without allowing a client to trickle bytes forever.
 *
 * On failure the stream is left as it is: a request body stays attached to
 * the connection its refusal is sent on (`sendReply` then closes it), and any
 * other stream is the caller's to destroy.
 */
export async function readStreamWithTimeouts(
  body: Readable,
  timeouts: StreamReadTimeouts,
  onChunk: (chunk: Buffer) => void | Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeouts.totalMs;
  const chunks: AsyncIterator<Buffer> = body[Symbol.asyncIterator]();
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("read_timeout");
    const { done, value } = await withReadTimeout(
      chunks.next(),
      Math.min(timeouts.idleMs, remainingMs),
    );
    if (done) break;
    await onChunk(value);
    if (Date.now() >= deadline) throw new Error("read_timeout");
  }
}

/** The request body as bytes, refusing more than `maxBytes` or a stalled stream. */
export async function readBoundedBody(
  req: IncomingMessage,
  maxBytes = MAX_HTTP_BODY_BYTES,
): Promise<Buffer<ArrayBuffer>> {
  const contentLength = getContentLength(req);
  if (contentLength !== null && contentLength > maxBytes) {
    throw new Error("payload_too_large");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  await readStreamWithTimeouts(
    req,
    { idleMs: HTTP_BODY_READ_TIMEOUT_MS, totalMs: HTTP_BODY_READ_TIMEOUT_MS },
    (chunk) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) throw new Error("payload_too_large");
      chunks.push(chunk);
    },
  );
  return Buffer.concat(chunks, totalBytes);
}

/** Parse a JSON object body; anything else is `invalid_json`. */
export function parseJsonObject<T>(body: Uint8Array): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("invalid_json");
  }
  // Every caller reads properties off the result. `null`, a number, a string
  // and an array all parse cleanly and then throw a TypeError on the first
  // access, so a five-byte `null` body reached handlers as an unhandled
  // exception rather than the 400 a malformed body gets.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid_json");
  }
  return parsed as T;
}

export async function readBoundedJson<T>(
  req: IncomingMessage,
  maxBytes = MAX_HTTP_BODY_BYTES,
): Promise<T> {
  return parseJsonObject<T>(await readBoundedBody(req, maxBytes));
}

export function jsonBodyErrorReply(error: unknown): Reply {
  if (error instanceof Error) {
    if (error.message === "payload_too_large") return Reply.json({ error: "Payload too large" }, 413);
    if (error.message === "read_timeout") return Reply.json({ error: "Request timeout" }, 408);
  }
  return Reply.json({ error: "Invalid JSON" }, 400);
}

export function createCorsHelpers({
  allowedOrigins,
  allowInsecureAllOrigins,
}: {
  allowedOrigins: string[];
  allowInsecureAllOrigins: boolean;
}) {
  function corsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = header(req, "Origin");
    if (!origin) return {};
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) return {};
    if (allowedOrigins.length === 0 && !allowInsecureAllOrigins) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };
  }

  function withCors(reply: Reply, req: IncomingMessage): Reply {
    return { ...reply, headers: { ...reply.headers, Vary: "Origin", ...corsHeaders(req) } };
  }

  return { corsHeaders, withCors };
}

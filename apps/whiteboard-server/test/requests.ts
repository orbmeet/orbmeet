import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

/**
 * A request as a route handler receives it: a readable body with the method,
 * target and (lower-cased) headers of an `IncomingMessage`. For handlers
 * tested without a server; routing and the wire are tested over real HTTP.
 */
export function incomingRequest({
  method = "GET",
  url = "/",
  headers = {},
  body,
  remoteAddress = "127.0.0.1",
}: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | Readable;
  remoteAddress?: string;
} = {}): IncomingMessage {
  const stream = body instanceof Readable ? body : Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  return Object.assign(stream, {
    method,
    url,
    headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;
}

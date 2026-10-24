import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/**
 * What a route answers: a status and a JSON or text body. Handlers and the
 * room code they call return one as plain data; only `sendReply` (or
 * `refuseUpgrade`, before a WebSocket handshake) ever writes it to a socket.
 */
export interface Reply {
  status: number;
  /** Sent as `application/json`. */
  json?: unknown;
  /** Sent as `text/plain`. */
  text?: string;
  headers?: Record<string, string>;
}

export const Reply = {
  json(body: unknown, status = 200, headers?: Record<string, string>): Reply {
    return { status, json: body, ...(headers ? { headers } : {}) };
  },
  text(body: string, status: number, headers?: Record<string, string>): Reply {
    return { status, text: body, ...(headers ? { headers } : {}) };
  },
  empty(status: number, headers?: Record<string, string>): Reply {
    return { status, ...(headers ? { headers } : {}) };
  },
};

export function isSuccess(reply: Reply): boolean {
  return reply.status >= 200 && reply.status < 300;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function serialize(reply: Reply): { body: string | undefined; headers: Record<string, string | number> } {
  const headers: Record<string, string | number> = {};
  let body: string | undefined;
  if (reply.json !== undefined) {
    body = JSON.stringify(reply.json);
    headers["Content-Type"] = "application/json;charset=utf-8";
  } else if (reply.text !== undefined) {
    body = reply.text;
    headers["Content-Type"] = "text/plain;charset=utf-8";
  }
  if (body !== undefined) headers["Content-Length"] = Buffer.byteLength(body);
  Object.assign(headers, reply.headers, SECURITY_HEADERS);
  return { body, headers };
}

export function sendReply(req: IncomingMessage, res: ServerResponse, reply: Reply): void {
  const { body, headers } = serialize(reply);
  // A refusal sent before the body was read (too large, too slow) leaves the
  // rest of it on the wire. Closing is cheaper than reading it to reuse the
  // connection, and the only way to stop a client that keeps sending.
  if (!req.complete) headers.Connection = "close";
  res.writeHead(reply.status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

/** Answer an upgrade request over HTTP, without a handshake, and close the socket. */
export function refuseUpgrade(socket: Duplex, reply: Reply): void {
  if (socket.destroyed) return;
  const { body, headers } = serialize(reply);
  headers.Connection = "close";
  const head = [
    `HTTP/1.1 ${reply.status} ${STATUS_CODES[reply.status] ?? ""}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ].join("\r\n");
  socket.end(`${head}\r\n\r\n${body ?? ""}`);
}

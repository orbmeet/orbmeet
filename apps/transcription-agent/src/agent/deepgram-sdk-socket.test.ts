import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepgramMessage } from "./deepgram-attempt.js";
import { deepgramSocketFactory } from "./deepgram-socket.js";

/**
 * Drives the REAL Deepgram SDK client against a local WebSocket server.
 *
 * `client.listen.v1.connect()` returns a socket that is not connected until
 * its own `connect()` is called. Without that call `waitForOpen()` never
 * resolves, and every attempt times out while Deepgram is perfectly
 * reachable. Fakes cannot catch that, so this test uses the SDK itself.
 */

// `ws` is the SDK's own transport; resolve it the way the SDK does.
const requireFromSdk = createRequire(createRequire(import.meta.url).resolve("@deepgram/sdk/package.json"));
interface ServerSocket {
  send(data: string): void;
}
interface Server {
  on(event: "connection", listener: (socket: ServerSocket) => void): void;
  on(event: "listening", listener: () => void): void;
  address(): AddressInfo | string | null;
  close(callback: () => void): void;
}
const { WebSocketServer } = requireFromSdk("ws") as {
  WebSocketServer: new (options: { host: string; port: number }) => Server;
};

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function listen(): Promise<{ baseUrl: string; connections: () => number; send: (message: unknown) => void }> {
  const sockets: ServerSocket[] = [];
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server!.on("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    connections: () => sockets.length,
    send: (message) => {
      for (const socket of sockets) socket.send(JSON.stringify(message));
    },
  };
}

describe("deepgramSocketFactory with the real SDK", () => {
  it("opens the connection and delivers each message once", async () => {
    const deepgram = await listen();
    const open = deepgramSocketFactory({ deepgramApiKey: "test-key", deepgramBaseUrl: deepgram.baseUrl });
    const socket = await open("en-US");
    const messages: DeepgramMessage[] = [];
    socket.onMessage((message) => messages.push(message));

    await socket.waitForOpen();
    expect(deepgram.connections()).toBe(1);

    deepgram.send({ type: "UtteranceEnd", channel: [0, 1], last_word_end: 1 });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toEqual([{ type: "UtteranceEnd", channel: [0, 1], last_word_end: 1 }]);

    const closed = vi.fn();
    socket.onClose(closed);
    socket.close();
    expect(closed).toHaveBeenCalledOnce();
  });
});

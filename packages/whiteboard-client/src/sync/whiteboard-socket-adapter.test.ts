import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import {
  buildWhiteboardWebSocketRequest,
  chunkMessage,
  isTransientSyncErrorReason,
  jitterReconnectDelayMs,
  WhiteboardWebSocketAdapter,
} from "./whiteboard-socket-adapter";
import { JsonMessageAssembler } from "@orbmeet/whiteboard-core/chunked-json";

describe("buildWhiteboardWebSocketRequest", () => {
  it("moves hash tokens into the websocket protocol list", () => {
    const request = buildWhiteboardWebSocketRequest(
      "https://whiteboard.example/connect#token=jwt",
      { sessionId: "tab-1", storeId: "store-1" },
    );

    const url = new URL(request.uri);
    expect(url.protocol).toBe("wss:");
    expect(url.searchParams.get("sessionId")).toBe("tab-1");
    expect(url.searchParams.get("storeId")).toBe("store-1");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("");
    expect(request.protocols).toEqual(["jwt", "orbmeet-wb"]);
  });

  it("moves query tokens into the websocket protocol list", () => {
    const request = buildWhiteboardWebSocketRequest(
      "ws://whiteboard.example/connect?room=a&token=jwt",
      { sessionId: "tab-1", storeId: "store-1" },
    );

    const url = new URL(request.uri);
    expect(url.protocol).toBe("ws:");
    expect(url.searchParams.get("room")).toBe("a");
    expect(url.searchParams.has("token")).toBe(false);
    expect(request.protocols).toEqual(["jwt", "orbmeet-wb"]);
  });

  it("overwrites reserved sync query params", () => {
    const request = buildWhiteboardWebSocketRequest(
      "https://whiteboard.example/connect?sessionId=old&storeId=old#token=jwt",
      { sessionId: "fresh-session", storeId: "fresh-store" },
    );

    const url = new URL(request.uri);
    expect(url.searchParams.get("sessionId")).toBe("fresh-session");
    expect(url.searchParams.get("storeId")).toBe("fresh-store");
  });
});

describe("isTransientSyncErrorReason", () => {
  // The reasons a wifi blip during token refresh surfaces as — must stay
  // recoverable so the board self-heals instead of going permanently "error".
  it("classifies auth/backend/rate-limit reasons as transient", () => {
    expect(isTransientSyncErrorReason(TLSyncErrorCloseEventReason.NOT_AUTHENTICATED)).toBe(true);
    expect(isTransientSyncErrorReason(TLSyncErrorCloseEventReason.UNKNOWN_ERROR)).toBe(true);
    expect(isTransientSyncErrorReason(TLSyncErrorCloseEventReason.RATE_LIMITED)).toBe(true);
    expect(isTransientSyncErrorReason(TLSyncErrorCloseEventReason.ROOM_FULL)).toBe(true);
  });

  it("classifies a reason never emitted by the server as transient", () => {
    // Defensive: an unrecognized reason must not become terminal. If the server
    // ever ships a new reason, the worst case is that we retry rather than
    // permanently kill the board.
    expect(isTransientSyncErrorReason("SOME_NEW_REASON")).toBe(true);
    expect(isTransientSyncErrorReason("")).toBe(true);
  });

  it("classifies genuinely permanent reasons as fatal", () => {
    expect(isTransientSyncErrorReason(TLSyncErrorCloseEventReason.NOT_FOUND)).toBe(false);
    expect(isTransientSyncErrorReason(TLSyncErrorCloseEventReason.FORBIDDEN)).toBe(false);
    expect(isTransientSyncErrorReason(TLSyncErrorCloseEventReason.CLIENT_TOO_OLD)).toBe(false);
    expect(isTransientSyncErrorReason(TLSyncErrorCloseEventReason.SERVER_TOO_OLD)).toBe(false);
    expect(isTransientSyncErrorReason(TLSyncErrorCloseEventReason.INVALID_RECORD)).toBe(false);
  });
});

// A minimal WebSocket double the adapter can `new`. vitest requires the factory
// to be a real function/class for `new` to behave, so StubWebSocket is a class.
// The adapter assigns onopen/onmessage/onclose/onerror and calls send(); each
// instance is recorded so a test can drive the exact close event the sync server
// would produce, then assert the status the adapter reports to tldraw's
// TLSyncClient — which decides whether the sync client is torn down ("error")
// or keeps retrying ("offline").
class StubWebSocket {
  static instances: StubWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;
  // Real sockets report CONNECTING(0) → OPEN(1) → CLOSING(2) → CLOSED(3), and
  // silently discard anything sent past OPEN.
  readyState = 1;
  sent: string[] = [];
  constructor() {
    StubWebSocket.instances.push(this);
  }
  close() { this.closeCalls += 1; }
  send(part: string) {
    this.sent.push(part);
  }
}

function installStubbedWebSocket() {
  StubWebSocket.instances = [];
  vi.stubGlobal("WebSocket", StubWebSocket);
  return { sockets: StubWebSocket.instances };
}

// The adapter constructor fire-and-forgets an async connect() that awaits
// getUri() before reaching `new WebSocket`. That await only resolves when the
// event loop turns over (a macrotask boundary), so yield before asserting.
async function flushConnect() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// How long to wait for the adapter's reconnect backoff to fire and open a
// replacement socket. After one transient close the first attempt lands at
// MIN_RECONNECT_DELAY_MS (500ms), so 1.5s is ample headroom without exceeding
// vitest's default 5s test timeout.
const RECONNECT_WAIT_MS = 1_500;

describe("WhiteboardWebSocketAdapter close-reason routing", () => {
  beforeEach(() => {
    // Reconnect delays are full-jittered across [0, ceiling]. Pin the draw to
    // the ceiling so the backoff *progression* stays observable here; the
    // jitter itself is covered by its own describe block below.
    vi.spyOn(Math, "random").mockReturnValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Drives the adapter through its initial connect→open so a status listener is
  // attached before the server-initiated close we want to test.
  async function createConnectedAdapter() {
    const { sockets } = installStubbedWebSocket();
    const adapter = new WhiteboardWebSocketAdapter(
      () => "wss://whiteboard.example/connect",
      { sessionId: "s1", storeId: "st1" },
    );
    await flushConnect();
    const socket = sockets.at(-1)!;
    const statuses: Array<{ status: string; reason?: string }> = [];
    adapter.onStatusChange((ev) => statuses.push(ev));
    socket.onopen?.();
    return { adapter, socket, statuses };
  }

  it("treats a NOT_AUTHENTICATED 4099 close as recoverable offline", async () => {
    const { socket, statuses, adapter } = await createConnectedAdapter();
    // /connect on a stale/expired token: close(4099, NOT_AUTHENTICATED).
    socket.onclose?.({ code: TLSyncErrorCloseEventCode, reason: TLSyncErrorCloseEventReason.NOT_AUTHENTICATED });

    expect(statuses.at(-1)).toEqual({ status: "offline" });
    // No terminal error was ever surfaced.
    expect(statuses.some((s) => s.status === "error")).toBe(false);
    adapter.close();
  });

  it("refuses a message larger than the server can assemble", async () => {
    const { adapter, socket, statuses } = await createConnectedAdapter();
    expect(() => adapter.sendMessage({ data: "x".repeat(16 * 1024 * 1024) }))
      .not.toThrow();
    expect(socket.sent).toHaveLength(0);
    expect(socket.closeCalls).toBe(1);
    expect(statuses.at(-1)).toEqual({
      status: "error",
      reason: TLSyncErrorCloseEventReason.INVALID_RECORD,
    });
    adapter.close();
  });

  it("treats an UNKNOWN_ERROR 4099 close as recoverable offline", async () => {
    // The VPS↔Worker access-validation call flaked → the server closes 4099/UNKNOWN_ERROR.
    const { socket, statuses, adapter } = await createConnectedAdapter();
    socket.onclose?.({ code: TLSyncErrorCloseEventCode, reason: TLSyncErrorCloseEventReason.UNKNOWN_ERROR });

    expect(statuses.at(-1)).toEqual({ status: "offline" });
    expect(statuses.some((s) => s.status === "error")).toBe(false);
    adapter.close();
  });

  it("keeps a ROOM_FULL client recoverable so content can be deleted", async () => {
    const { socket, statuses, adapter } = await createConnectedAdapter();
    socket.onclose?.({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.ROOM_FULL,
    });

    expect(statuses.at(-1)).toEqual({ status: "offline" });
    expect(statuses.some((status) => status.status === "error")).toBe(false);
    adapter.close();
  });

  it("does not suppress a push after a legacy ROOM_FULL reconnect", async () => {
    const { socket, adapter } = await createConnectedAdapter();
    const rejectedPush = { type: "push", diff: { put: { shape: { x: 1 } } } };
    adapter.sendMessage(rejectedPush);
    expect(socket.sent).toHaveLength(1);

    socket.onclose?.({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.ROOM_FULL,
    });
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_WAIT_MS));
    const replacement = StubWebSocket.instances.at(-1)!;
    replacement.onopen?.();

    adapter.sendMessage(rejectedPush);
    expect(replacement.sent).toHaveLength(1);
    adapter.sendMessage({ type: "push", diff: { remove: { shape: true } } });
    expect(replacement.sent).toHaveLength(2);
    adapter.close();
  });

  it("treats a raw TCP drop (non-4099 close) as recoverable offline", async () => {
    const { socket, statuses, adapter } = await createConnectedAdapter();
    socket.onclose?.({ code: 1006, reason: "" });

    expect(statuses.at(-1)).toEqual({ status: "offline" });
    expect(statuses.some((s) => s.status === "error")).toBe(false);
    adapter.close();
  });

  it("treats an onerror event as recoverable offline", async () => {
    const { socket, statuses, adapter } = await createConnectedAdapter();
    socket.onerror?.();

    expect(statuses.at(-1)).toEqual({ status: "offline" });
    expect(statuses.some((s) => s.status === "error")).toBe(false);
    expect(socket.closeCalls).toBe(1);
    adapter.close();
  });

  it("retires the socket after a malformed frame so sync rehydrates", async () => {
    const { socket, statuses, adapter } = await createConnectedAdapter();

    socket.onmessage?.({ data: "{not-json" });

    expect(statuses.at(-1)).toEqual({ status: "offline" });
    expect(socket.closeCalls).toBe(1);
    adapter.close();
  });

  it("isolates application listeners without retiring a healthy socket", async () => {
    const { socket, statuses, adapter } = await createConnectedAdapter();
    const laterListener = vi.fn();
    adapter.onReceiveMessage(() => {
      throw new Error("application handler failed");
    });
    adapter.onReceiveMessage(laterListener);

    expect(() => socket.onmessage?.({ data: JSON.stringify({ type: "custom" }) }))
      .not.toThrow();
    expect(laterListener).toHaveBeenCalledWith({ type: "custom" });
    expect(statuses.at(-1)).toEqual({ status: "online" });
    expect(socket.closeCalls).toBe(0);
    adapter.close();
  });

  it("reconnects when the handshake could not be applied (REVIEW #10)", async () => {
    const { socket, statuses, adapter } = await createConnectedAdapter();
    adapter.onReceiveMessage(() => {
      throw new Error("tldraw failed to apply connect");
    });

    socket.onmessage?.({ data: JSON.stringify({ type: "connect" }) });

    // Online but never joined would drop every later data frame silently.
    expect(statuses.at(-1)).toEqual({ status: "offline" });
    expect(socket.closeCalls).toBe(1);
    adapter.close();
  });

  it("does not open a replacement while the errored socket is still CLOSING", async () => {
    vi.useFakeTimers();
    const { sockets } = installStubbedWebSocket();
    const adapter = new WhiteboardWebSocketAdapter(
      () => "wss://whiteboard.example/connect",
      { sessionId: "s1", storeId: "st1" },
    );
    await vi.advanceTimersByTimeAsync(0);
    const firstSocket = sockets.at(-1)!;
    firstSocket.onopen?.();

    firstSocket.onerror?.();
    firstSocket.readyState = 2; // CLOSING — the handshake has not completed.

    // A CLOSING socket is still OPEN to the server and still holds one of the
    // three per-user slots. Opening a replacement now is how a single flap used
    // to burn two slots and end in `1008 Too many connections`.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(1);

    firstSocket.readyState = 3;
    firstSocket.onclose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    adapter.close();
  });

  it("reconnects anyway when the closing handshake never completes", async () => {
    vi.useFakeTimers();
    const { sockets } = installStubbedWebSocket();
    const adapter = new WhiteboardWebSocketAdapter(
      () => "wss://whiteboard.example/connect",
      { sessionId: "s1", storeId: "st1" },
    );
    await vi.advanceTimersByTimeAsync(0);
    sockets.at(-1)!.onopen?.();
    sockets.at(-1)!.onerror?.();

    // Grace period (3s) plus the backoff ceiling (500ms). Waiting forever for a
    // `close` event that never lands would leave the board permanently offline.
    await vi.advanceTimersByTimeAsync(3_500);
    expect(sockets).toHaveLength(2);
    adapter.close();
  });
  it("ignores the errored socket's delayed close after scheduling one reconnect", async () => {
    vi.useFakeTimers();
    const { sockets } = installStubbedWebSocket();
    const adapter = new WhiteboardWebSocketAdapter(
      () => "wss://whiteboard.example/connect",
      { sessionId: "s1", storeId: "st1" },
    );
    await vi.advanceTimersByTimeAsync(0);
    const firstSocket = sockets.at(-1)!;
    firstSocket.onopen?.();
    firstSocket.onerror?.();
    firstSocket.onclose?.({ code: 1006, reason: "" });

    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(750);
    expect(sockets).toHaveLength(2);
    adapter.close();
  });

  it("surfaces a FORBIDDEN 4099 close as terminal error", async () => {
    const { socket, statuses, adapter } = await createConnectedAdapter();
    socket.onclose?.({ code: TLSyncErrorCloseEventCode, reason: TLSyncErrorCloseEventReason.FORBIDDEN });

    expect(statuses.at(-1)).toEqual({
      status: "error",
      reason: TLSyncErrorCloseEventReason.FORBIDDEN,
    });
    adapter.close();
  });

  it("reconnects after a transient 4099 close, opening a new socket", async () => {
    const { sockets } = installStubbedWebSocket();
    const adapter = new WhiteboardWebSocketAdapter(
      () => "wss://whiteboard.example/connect",
      { sessionId: "s1", storeId: "st1" },
    );
    await flushConnect();
    const firstSocket = sockets.at(-1)!;
    firstSocket.onopen?.();
    // Simulate the blip: server closes 4099/NOT_AUTHENTICATED.
    firstSocket.onclose?.({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.NOT_AUTHENTICATED,
    });

    // One socket existed before the blip.
    expect(sockets.length).toBe(1);

    // Wait out the reconnect backoff; the adapter opens a fresh socket, which is
    // how a stale token gets re-resolved (getWebSocketUri re-mints on reconnect).
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_WAIT_MS));

    expect(sockets.length).toBe(2);
    adapter.close();
  });

  it("does not reset reconnect backoff for an immediately rejected 101 upgrade", async () => {
    vi.useFakeTimers();
    const { sockets } = installStubbedWebSocket();
    const adapter = new WhiteboardWebSocketAdapter(
      () => "wss://whiteboard.example/connect",
      { sessionId: "s1", storeId: "st1" },
    );
    await vi.advanceTimersByTimeAsync(0);

    const firstSocket = sockets.at(-1)!;
    firstSocket.onopen?.();
    firstSocket.onclose?.({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.NOT_AUTHENTICATED,
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    const secondSocket = sockets.at(-1)!;
    secondSocket.onopen?.();
    secondSocket.onclose?.({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.NOT_AUTHENTICATED,
    });

    // The second rejection waits 750ms. Resetting on `open` would create the
    // third socket after only another 500ms and recreate the observed storm.
    await vi.advanceTimersByTimeAsync(600);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(150);
    expect(sockets).toHaveLength(3);
    adapter.close();
  });

  // A guest granted edit access is revoked with NOT_AUTHENTICATED so it picks up
  // an editing token. A URI factory that caches tokens cannot see that from
  // socket status alone — the server upgrades, then closes, a rejected socket —
  // so it resent the stale token until its own offline timeout expired.
  it("tells the URI factory when the last socket's token was rejected", async () => {
    vi.useFakeTimers();
    const { sockets } = installStubbedWebSocket();
    const attempts: Array<{ tokenRejected: boolean }> = [];
    const adapter = new WhiteboardWebSocketAdapter(
      (attempt) => {
        attempts.push(attempt);
        return "wss://whiteboard.example/connect";
      },
      { sessionId: "s1", storeId: "st1" },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual([{ tokenRejected: false }]);

    const rejectStale = () => {
      const socket = sockets.at(-1)!;
      socket.onopen?.();
      socket.onclose?.({
        code: TLSyncErrorCloseEventCode,
        reason: TLSyncErrorCloseEventReason.NOT_AUTHENTICATED,
      });
    };

    rejectStale();
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts.at(-1)).toEqual({ tokenRejected: true });

    // Still stale until the server accepts a socket.
    rejectStale();
    await vi.advanceTimersByTimeAsync(750);
    expect(attempts.at(-1)).toEqual({ tokenRejected: true });

    // The server synced this socket, so its token is current again; a later
    // drop for another reason must not force a mint.
    const accepted = sockets.at(-1)!;
    accepted.onopen?.();
    accepted.onmessage?.({ data: JSON.stringify({ type: "connect" }) });
    accepted.onclose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts.at(-1)).toEqual({ tokenRejected: false });
    adapter.close();
  });

});

describe("WhiteboardWebSocketAdapter connection generations", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("leaves exactly one live socket when restart races a slow token mint", async () => {
    const { sockets } = installStubbedWebSocket();
    const pendingUris: Array<(uri: string) => void> = [];
    const adapter = new WhiteboardWebSocketAdapter(
      () => new Promise<string>((resolve) => pendingUris.push(resolve)),
      { sessionId: "s1", storeId: "st1" },
    );

    // The constructor's connect() is parked on getUri(). tldraw's health check
    // fires restart() in the meantime, starting a second overlapping attempt.
    await flushConnect();
    expect(pendingUris).toHaveLength(1);
    adapter.restart();
    await flushConnect();
    expect(pendingUris).toHaveLength(2);

    // Resolve the *superseded* mint first — the ordering that used to construct
    // an extra WebSocket and then have the newer attempt overwrite it.
    pendingUris[0]("wss://whiteboard.example/connect?gen=1");
    await flushConnect();
    pendingUris[1]("wss://whiteboard.example/connect?gen=2");
    await flushConnect();

    expect(sockets).toHaveLength(1);
    adapter.close();
  });

  // restart() closes and reconnects through the same handshake wait as the
  // error path. Replacing the socket eagerly was the one remaining way to run
  // two sockets for one session against MAX_CONNECTIONS_PER_USER.
  it("waits for a restarted socket's handshake before replacing it", async () => {
    vi.useFakeTimers();
    const { sockets } = installStubbedWebSocket();
    const adapter = new WhiteboardWebSocketAdapter(
      () => "wss://whiteboard.example/connect",
      { sessionId: "s1", storeId: "st1" },
    );
    await vi.advanceTimersByTimeAsync(0);
    const firstSocket = sockets.at(-1)!;
    firstSocket.onopen?.();

    adapter.restart();
    expect(firstSocket.closeCalls).toBe(1);
    firstSocket.readyState = 2; // CLOSING — still holding a server-side slot.

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(1);

    firstSocket.readyState = 3;
    firstSocket.onclose?.({ code: 1000, reason: "" });
    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS);

    expect(sockets).toHaveLength(2);
    adapter.close();
  });

  it("restarts immediately when no socket has been constructed yet", async () => {
    vi.useFakeTimers();
    const { sockets } = installStubbedWebSocket();
    const pendingUris: Array<(uri: string) => void> = [];
    const adapter = new WhiteboardWebSocketAdapter(
      () => new Promise<string>((resolve) => pendingUris.push(resolve)),
      { sessionId: "s1", storeId: "st1" },
    );
    await vi.advanceTimersByTimeAsync(0);

    // Nothing to hand back to the server, so there is no handshake to wait on.
    adapter.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(pendingUris).toHaveLength(2);

    pendingUris[1]("wss://whiteboard.example/connect");
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    adapter.close();
  });

  it("ignores a superseded socket's events", async () => {
    vi.useFakeTimers();
    const { sockets } = installStubbedWebSocket();
    const adapter = new WhiteboardWebSocketAdapter(
      () => "wss://whiteboard.example/connect",
      { sessionId: "s1", storeId: "st1" },
    );
    await vi.advanceTimersByTimeAsync(0);
    const firstSocket = sockets.at(-1)!;
    const statuses: Array<{ status: string; reason?: string }> = [];
    adapter.onStatusChange((ev) => statuses.push(ev));

    adapter.restart();
    firstSocket.readyState = 3;
    firstSocket.onclose?.({ code: 1000, reason: "" });
    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS);
    const secondSocket = sockets.at(-1)!;
    expect(secondSocket).not.toBe(firstSocket);
    secondSocket.onopen?.();
    expect(statuses.at(-1)).toEqual({ status: "online" });

    // The orphan's delayed FORBIDDEN close must not take the live connection
    // terminal — it belongs to a generation that is no longer in charge.
    firstSocket.onclose?.({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.FORBIDDEN,
    });

    expect(statuses.at(-1)).toEqual({ status: "online" });
    adapter.close();
  });
});

describe("jitterReconnectDelayMs", () => {
  it("stays within [0, ceiling]", () => {
    for (const ceiling of [500, 750, 1125, 5_000]) {
      for (let i = 0; i < 200; i++) {
        const delay = jitterReconnectDelayMs(ceiling);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("varies rather than landing every client on the same millisecond", () => {
    const draws = new Set(
      Array.from({ length: 200 }, () => jitterReconnectDelayMs(5_000)),
    );

    // The whole point: a synchronised reconnect storm needs identical delays.
    expect(draws.size).toBeGreaterThan(1);
  });

  it("uses the whole window", () => {
    expect(jitterReconnectDelayMs(750, () => 0)).toBe(0);
    expect(jitterReconnectDelayMs(750, () => 1)).toBe(750);
  });
});

describe("WhiteboardWebSocketAdapter sendMessage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function createConnectedAdapter() {
    const { sockets } = installStubbedWebSocket();
    const adapter = new WhiteboardWebSocketAdapter(
      () => "wss://whiteboard.example/connect",
      { sessionId: "s1", storeId: "st1" },
    );
    await flushConnect();
    const socket = sockets.at(-1)!;
    socket.onopen?.();
    return { adapter, socket };
  }

  it("sends while the socket is open", async () => {
    const { adapter, socket } = await createConnectedAdapter();
    adapter.sendMessage({ type: "ping" });

    expect(socket.sent).toEqual([JSON.stringify({ type: "ping" })]);
    adapter.close();
  });

  // connectionStatus only leaves "online" when the close event is dispatched, so
  // there is a window where the adapter still believes it is online while the
  // socket is already CLOSING. A CLOSING socket discards whatever it is handed,
  // so the point of skipping is to not serialize and chunk a push for nothing.
  it("skips sending once the socket has left OPEN, even while status says online", async () => {
    const { adapter, socket } = await createConnectedAdapter();
    socket.readyState = 2; // CLOSING — close event not dispatched yet.

    adapter.sendMessage({ type: "ping" });

    expect(socket.sent).toEqual([]);
    adapter.close();
  });
});

describe("chunkMessage", () => {
  // Mirrors MAX_SAFE_MESSAGE_SIZE in whiteboard-socket-adapter.ts.
  const MAX_SAFE_MESSAGE_SIZE = (1024 * 1024) / 4;

  function reassemble(chunks: string[]): string {
    const assembler = new JsonMessageAssembler();
    let result: ReturnType<JsonMessageAssembler["handleMessage"]> = null;
    for (const chunk of chunks) result = assembler.handleMessage(chunk);
    if (!result || "error" in result) {
      throw new Error(`assembly failed: ${result && "error" in result ? result.error.message : "incomplete"}`);
    }
    return result.stringified;
  }

  it("passes short messages through unchunked", () => {
    expect(chunkMessage('{"type":"ping"}')).toEqual(['{"type":"ping"}']);
  });

  it("counts down to a zero-prefixed final chunk", () => {
    const chunks = chunkMessage(JSON.stringify({ type: "push", pad: "a".repeat(700_000) }));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startsWith(`${chunks.length - 1}_`)).toBe(true);
    expect(chunks[chunks.length - 1].startsWith("0_")).toBe(true);
  });

  it("round-trips an ASCII payload through the server assembler", () => {
    const message = JSON.stringify({ type: "push", pad: "a".repeat(700_000) });

    expect(reassemble(chunkMessage(message))).toBe(message);
  });

  it("never splits a surrogate pair, whatever the boundary alignment", () => {
    const HEAD = '{"type":"push","pad":"';
    const TAIL = '"}';
    // A message this long splits into two chunks, and the first `0_` chunk
    // takes MAX_SAFE_MESSAGE_SIZE - 2 code units off the tail — so the cut
    // lands at a known index from the start.
    const total = MAX_SAFE_MESSAGE_SIZE + 20_000;
    const boundary = total - (MAX_SAFE_MESSAGE_SIZE - 2);

    // Straddle the cut with astral characters at both alignments: one of the
    // two puts the boundary exactly between a high and a low surrogate.
    for (const shift of [0, 1]) {
      const emojiRun = "\u{1F600}".repeat(10);
      const beforeRun = boundary - 10 + shift;
      const message =
        HEAD +
        "a".repeat(beforeRun - HEAD.length) +
        emojiRun +
        "a".repeat(total - TAIL.length - beforeRun - emojiRun.length) +
        TAIL;
      expect(message.length).toBe(total);

      const chunks = chunkMessage(message);
      expect(chunks.length).toBe(2);
      for (const chunk of chunks) {
        const body = chunk.slice(chunk.indexOf("_") + 1);
        expect(body).not.toMatch(/^[\uDC00-\uDFFF]/);
        expect(body).not.toMatch(/[\uD800-\uDBFF]$/);
      }
      expect(reassemble(chunks)).toBe(message);
    }
  });

  it("keeps every chunk within the size ceiling", () => {
    const message =
      JSON.stringify({ type: "push", pad: "a".repeat(900_000) }).slice(0, -2) +
      "\u{1F600}".repeat(2048) +
      '"}';

    for (const chunk of chunkMessage(message)) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_SAFE_MESSAGE_SIZE);
    }
  });
});

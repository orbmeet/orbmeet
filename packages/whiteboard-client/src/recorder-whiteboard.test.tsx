// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64urlEncode } from "@orbmeet/whiteboard-core/crypto-utils";
import { RecorderWhiteboard } from "./recorder-whiteboard";

const connect = vi.hoisted(() => ({
  getWebSocketUri: null as ((attempt: { tokenRejected: boolean }) => Promise<string>) | null,
}));

vi.mock("./synced-whiteboard", () => ({
  SyncedWhiteboard: ({
    token,
    getWebSocketUri,
  }: {
    token: string;
    getWebSocketUri: (attempt: { tokenRejected: boolean }) => Promise<string>;
  }) => {
    connect.getWebSocketUri = getWebSocketUri;
    return <div data-testid="recorder-whiteboard">{token}</div>;
  },
}));

function jwtExpiringAt(expiresAt: number, marker: string) {
  const payload = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({ exp: expiresAt / 1000, marker })),
  );
  return `header.${payload}.signature`;
}

function authResponse(token: string, documentId = "wb_1") {
  return {
    ok: true,
    json: async () => ({
      token,
      whiteboardUrl: "https://whiteboard.example.com",
      documentId,
    }),
  } as Response;
}

// The auth endpoint is host-supplied; nothing in the package may embed a
// default route, so the test uses a URL that only the adapter could provide.
const SERVICE_ENDPOINTS = {
  recorderAuth: "https://api.example.test/whiteboard/recorder-auth",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RecorderWhiteboard auth refresh", () => {
  it("keeps a valid recorder session mounted and retries a transient proactive refresh", async () => {
    const now = new Date("2026-08-23T10:00:00.000Z");
    vi.useFakeTimers({ now });
    const initialToken = jwtExpiringAt(now.getTime() + 120_000, "initial");
    const refreshedToken = jwtExpiringAt(now.getTime() + 300_000, "refreshed");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(authResponse(initialToken))
      .mockRejectedValueOnce(new Error("temporary auth service failure"))
      .mockResolvedValueOnce(authResponse(refreshedToken));
    vi.stubGlobal("fetch", fetchMock);
    const onStatusChange = vi.fn();

    render(
      <RecorderWhiteboard
        capabilities={{
          reduceRasterMemory: false,
          disableCoalescedPointerEvents: false,
        }}
        whiteboardUrl="https://whiteboard.example.com"
        recorderToken="recorder-token"
        whiteboardId="wb_1"
        serviceEndpoints={SERVICE_ENDPOINTS}
        onStatusChange={onStatusChange}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      SERVICE_ENDPOINTS.recorderAuth,
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.getByTestId("recorder-whiteboard").textContent).toBe(initialToken);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("recorder-whiteboard").textContent).toBe(initialToken);
    expect(onStatusChange).not.toHaveBeenCalledWith("error");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("recorder-whiteboard").textContent).toBe(refreshedToken);
    expect(onStatusChange).not.toHaveBeenCalledWith("error");
  });

  it("reconnects with the token it holds, but mints a new one once the server rejected it", async () => {
    const now = new Date("2026-08-23T10:00:00.000Z");
    vi.useFakeTimers({ now });
    const held = jwtExpiringAt(now.getTime() + 3_600_000, "held");
    const reminted = jwtExpiringAt(now.getTime() + 3_600_000, "reminted");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(authResponse(held))
      .mockResolvedValueOnce(authResponse(reminted));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RecorderWhiteboard
        capabilities={{ reduceRasterMemory: false, disableCoalescedPointerEvents: false }}
        whiteboardUrl="https://whiteboard.example.com"
        recorderToken="recorder-token"
        whiteboardId="wb_1"
        serviceEndpoints={SERVICE_ENDPOINTS}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // A dropped connection reuses a token with an hour left.
    await expect(connect.getWebSocketUri!({ tokenRejected: false })).resolves.toContain(held);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A rejected one is never resent.
    let uri = "";
    await act(async () => {
      uri = await connect.getWebSocketUri!({ tokenRejected: true });
    });
    expect(uri).toContain(reminted);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follows the meeting to the board it presents now", async () => {
    const now = new Date("2026-08-23T10:00:00.000Z");
    vi.useFakeTimers({ now });
    const first = jwtExpiringAt(now.getTime() + 3_600_000, "first");
    const second = jwtExpiringAt(now.getTime() + 3_600_000, "second");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(authResponse(first, "wb_1"))
      .mockResolvedValueOnce(authResponse(second, "wb_2"));
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      capabilities: { reduceRasterMemory: false, disableCoalescedPointerEvents: false },
      whiteboardUrl: "https://whiteboard.example.com",
      recorderToken: "recorder-token",
      serviceEndpoints: SERVICE_ENDPOINTS,
    };

    const { rerender } = render(<RecorderWhiteboard {...props} whiteboardId="wb_1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("recorder-whiteboard").textContent).toBe(first);

    rerender(<RecorderWhiteboard {...props} whiteboardId="wb_2" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("recorder-whiteboard").textContent).toBe(second);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushTelemetry, postTelemetry, telemetryTabId } from "./outbox";

const fetchMock = vi.fn<typeof fetch>();
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sessionStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telemetry outbox", () => {
  it("keeps what cannot reach the Worker and sends it, in order, once it can", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    postTelemetry("/api/x", { n: 1 });
    postTelemetry("/api/x", { n: 2 });
    await settle();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("OK"));
    await flushTelemetry();
    expect(bodies()).toEqual([{ n: 1 }, { n: 2 }]);

    fetchMock.mockClear();
    await flushTelemetry();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends what waited along with the next report that gets through", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    postTelemetry("/api/x", { n: 1 });
    await settle();

    fetchMock.mockResolvedValue(new Response("OK"));
    postTelemetry("/api/x", { n: 2 });
    await settle();
    await flushTelemetry();
    expect(bodies()).toEqual([{ n: 1 }, { n: 2 }, { n: 1 }]);
  });

  it("does not send again what the Worker refused", async () => {
    fetchMock.mockResolvedValue(new Response("Too many requests", { status: 429 }));
    postTelemetry("/api/x", { n: 1 });
    await settle();
    await flushTelemetry();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("names the tab the same way across reloads", () => {
    const id = telemetryTabId();
    expect(telemetryTabId()).toBe(id);
    expect(sessionStorage.getItem("orbmeet:telemetry-tab")).toBe(id);
  });
});

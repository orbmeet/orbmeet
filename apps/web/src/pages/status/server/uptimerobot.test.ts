import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildService,
  fetchServiceUptime,
  parseMonitorIds,
  type UrMonitor,
} from "@/pages/status/server/uptimerobot";

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const seconds = (iso: string) => Date.parse(iso) / 1000;
const meetings = { service: "meetings" as const, name: "Video meetings", monitorIds: [] };

function monitor(
  id: number,
  name: string,
  downs: Array<[start: string, minutes: number | "ongoing"]> = [],
  options: { status?: number; created?: string } = {},
): UrMonitor {
  return {
    id,
    friendly_name: name,
    status: options.status ?? 2,
    create_datetime: seconds(options.created ?? "2026-01-01T00:00:00.000Z"),
    logs: downs.map(([start, minutes]) => ({
      type: 1,
      datetime: seconds(start),
      duration: minutes === "ongoing" ? 0 : minutes * 60,
      reason: { code: 503, detail: "Service Unavailable" },
    })),
  };
}

const today = (service: ReturnType<typeof buildService>) => service.days.at(-1)!;

describe("buildService", () => {
  it("reports one monitor's downtime as the service's own", () => {
    const service = buildService(
      { service: "whiteboard", name: "Whiteboard", monitorIds: [] },
      [monitor(1, "whiteboard", [["2026-09-25T06:00:00.000Z", 60]])],
      NOW,
    );

    expect(service.health).toBe("operational");
    // One hour down in the twelve hours of today so far.
    expect(today(service)).toMatchObject({ hasIncident: true });
    expect(today(service).uptimePct).toBeCloseTo(91.667, 2);
    expect(service.recentIncidents).toEqual([
      expect.objectContaining({ scope: "service", serviceAffected: true, resolvedAt: expect.any(String) }),
    ]);
  });

  it("stays up, degraded, while one of several servers is down", () => {
    const service = buildService(
      meetings,
      [
        monitor(1, "Singapore", [["2026-09-25T11:30:00.000Z", "ongoing"]], { status: 9 }),
        monitor(2, "Malaysia"),
      ],
      NOW,
    );

    expect(service.health).toBe("degraded");
    expect(today(service)).toMatchObject({ uptimePct: 100, hasIncident: true });
    expect(service.uptimePct).toBe(100);
    expect(service.recentIncidents).toEqual([
      expect.objectContaining({ scope: "server", serviceAffected: false, resolvedAt: null }),
    ]);
  });

  it("is down only while every server is down at once", () => {
    const service = buildService(
      meetings,
      [
        monitor(1, "Singapore", [["2026-09-25T06:00:00.000Z", 60]]),
        // Overlaps the last 30 minutes of Singapore's outage.
        monitor(2, "Malaysia", [["2026-09-25T06:30:00.000Z", 60]]),
      ],
      NOW,
    );

    expect(service.health).toBe("operational");
    expect(today(service).uptimePct).toBeCloseTo(((12 * 60 - 30) / (12 * 60)) * 100, 3);
    expect(service.recentIncidents.map((i) => [i.id, i.startedAt, i.scope, i.serviceAffected])).toEqual([
      ["meetings-0", "2026-09-25T06:30:00.000Z", "server", true],
      ["meetings-1", "2026-09-25T06:00:00.000Z", "server", true],
    ]);
  });

  it("is an outage when every server is down now", () => {
    const service = buildService(
      meetings,
      [monitor(1, "Singapore", [], { status: 9 }), monitor(2, "Malaysia", [], { status: 8 })],
      NOW,
    );
    expect(service.health).toBe("outage");
  });

  it("does not count a server before it was monitored", () => {
    const service = buildService(
      meetings,
      [
        monitor(1, "Singapore", [["2026-09-25T02:00:00.000Z", 60]]),
        // Added after Singapore's outage, so that outage took the service down.
        monitor(2, "Malaysia", [], { created: "2026-09-25T08:00:00.000Z" }),
      ],
      NOW,
    );
    expect(today(service).uptimePct).toBeCloseTo(((12 * 60 - 60) / (12 * 60)) * 100, 3);
  });

  it("shows no data before monitoring began, and a partial first day", () => {
    const service = buildService(
      meetings,
      [monitor(1, "Singapore", [], { created: "2026-09-24T12:00:00.000Z" })],
      NOW,
    );
    expect(service.days.at(-3)).toMatchObject({ uptimePct: -1 });
    expect(service.days.at(-2)).toMatchObject({ date: "2026-09-24", uptimePct: 100 });
    expect(service.days).toHaveLength(90);
  });

  it("is unknown without monitors", () => {
    const service = buildService(meetings, [], NOW);
    expect(service).toMatchObject({ health: "unknown", uptimePct: null });
    expect(service.days.every((day) => day.uptimePct === -1)).toBe(true);
  });
});

describe("parseMonitorIds", () => {
  it("reads a comma-separated list and ignores anything that is not an id", () => {
    expect(parseMonitorIds(" 802910459, 802911234 ,,x")).toEqual(["802910459", "802911234"]);
    expect(parseMonitorIds(undefined)).toEqual([]);
  });
});

describe("fetchServiceUptime", () => {
  it("asks for every monitor once and groups them by service", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ stat: "ok", monitors: [monitor(1, "Singapore"), monitor(2, "Malaysia"), monitor(3, "wb")] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const services = await fetchServiceUptime(
      "key",
      [
        { ...meetings, monitorIds: ["1", "2"] },
        { service: "whiteboard", name: "Whiteboard", monitorIds: ["3"] },
      ],
      NOW,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URLSearchParams(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).get("monitors"))
      .toBe("1-2-3");
    expect(services.map((s) => [s.service, s.health])).toEqual([
      ["meetings", "operational"],
      ["whiteboard", "operational"],
    ]);
    // Nothing about individual servers reaches the page.
    expect(JSON.stringify(services)).not.toMatch(/Singapore|Malaysia|servers/);
  });

  it("makes no request when nothing is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const [service] = await fetchServiceUptime("key", [meetings], NOW);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.health).toBe("unknown");
  });
});

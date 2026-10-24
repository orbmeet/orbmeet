// ─── UptimeRobot Uptime API client ───────────────────────────────────
// Uses POST /v2/getMonitors with logs (down events) to reconstruct each
// service's 90-day history. A service is backed by one or more monitors: Video
// meetings has one per media server, and it is down only while every server is.

const BASE = "https://api.uptimerobot.com/v2";
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 90;
const MAX_INCIDENTS = 10;

// ─── API response shapes ─────────────────────────────────────────────

interface UrLog {
  type: number; // 1=down, 2=up, 98=started, 99=paused
  datetime: number; // Unix timestamp
  duration: number; // seconds; 0 = ongoing
  reason?: { code: number; detail?: string };
}

export interface UrMonitor {
  id: number;
  friendly_name: string;
  status: number; // 0=paused, 1=notChecked, 2=up, 8=seemsDown, 9=down
  create_datetime: number; // Unix timestamp
  logs?: UrLog[];
}

interface UrResponse {
  stat: "ok" | "fail";
  monitors?: UrMonitor[];
  error?: { type: string; message: string };
}

// ─── Exported domain types ────────────────────────────────────────────

type StatusServiceId = "meetings" | "whiteboard";

/** One monitor's current state. */
type MonitorStatus = "up" | "down" | "unknown";

/**
 * A service's current state: `degraded` when some of its servers are down but
 * it still works on the others, `outage` when it does not work at all.
 */
export type ServiceHealth = "operational" | "degraded" | "outage" | "unknown";

// The page never names or counts the servers behind a service: which one is
// down is the operator's concern, and how many there are is nobody else's.

export interface DayUptime {
  date: string; // YYYY-MM-DD
  /** The service's own availability that day, 0–100, or -1 before monitoring began. */
  uptimePct: number;
  /** Whether any of its servers was down that day, even if the service was not. */
  hasIncident: boolean;
}

export interface RecentIncident {
  id: string;
  /** `server`: one of several servers behind the service went down. */
  scope: "service" | "server";
  cause: string | null;
  startedAt: string;
  resolvedAt: string | null;
  /** False when other servers kept the service up throughout. */
  serviceAffected: boolean;
}

export interface ServiceUptime {
  service: StatusServiceId;
  name: string;
  health: ServiceHealth;
  days: DayUptime[];
  /** 90-day availability, or null before any monitoring data exists. */
  uptimePct: number | null;
  recentIncidents: RecentIncident[];
}

export interface StatusMonitorConfig {
  service: StatusServiceId;
  name: string;
  monitorIds: string[];
}

// ─── Intervals ───────────────────────────────────────────────────────

type Interval = readonly [start: number, end: number];

function overlapMs(intervals: readonly Interval[], from: number, to: number): number {
  let total = 0;
  for (const [start, end] of intervals) {
    const a = Math.max(start, from);
    const b = Math.min(end, to);
    if (a < b) total += b - a;
  }
  return total;
}

function overlaps(intervals: readonly Interval[], from: number, to: number): boolean {
  return intervals.some(([start, end]) => start < to && end > from);
}

interface MemberHistory {
  status: MonitorStatus;
  createdMs: number;
  down: Interval[];
  logs: UrLog[];
}

function memberHistory(monitor: UrMonitor, nowMs: number): MemberHistory {
  const createdMs = monitor.create_datetime * 1000;
  const logs = monitor.logs ?? [];
  const down = logs
    .filter((log) => log.type === 1)
    .map((log): Interval => {
      const start = Math.max(log.datetime * 1000, createdMs);
      const end = log.duration > 0 ? log.datetime * 1000 + log.duration * 1000 : nowMs;
      return [start, Math.min(end, nowMs)];
    })
    .filter(([start, end]) => start < end);
  const status: MonitorStatus =
    monitor.status === 2 ? "up" : monitor.status === 8 || monitor.status === 9 ? "down" : "unknown";
  return { status, createdMs, down, logs };
}

/**
 * When the service itself was down: every member that was being monitored at
 * the time was down. A member created later does not count before it existed.
 */
function serviceDownIntervals(members: readonly MemberHistory[], nowMs: number): Interval[] {
  const points = new Set<number>();
  for (const member of members) {
    points.add(Math.min(member.createdMs, nowMs));
    for (const [start, end] of member.down) {
      points.add(start);
      points.add(end);
    }
  }
  points.add(nowMs);
  const sorted = [...points].sort((a, b) => a - b);

  const intervals: Interval[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [from, to] = [sorted[i], sorted[i + 1]];
    const existing = members.filter((member) => member.createdMs <= from);
    const allDown =
      existing.length > 0
      && existing.every((member) => member.down.some(([start, end]) => start <= from && end >= to));
    if (!allDown) continue;
    const last = intervals.at(-1);
    if (last && last[1] === from) intervals[intervals.length - 1] = [last[0], to];
    else intervals.push([from, to]);
  }
  return intervals;
}

// ─── Builders ────────────────────────────────────────────────────────

function historyDates(nowMs: number): string[] {
  const dates: string[] = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    dates.push(new Date(nowMs - i * DAY_MS).toISOString().slice(0, 10));
  }
  return dates;
}

function serviceHealth(members: readonly MemberHistory[]): ServiceHealth {
  const known = members.filter((member) => member.status !== "unknown");
  if (known.length === 0) return "unknown";
  const down = known.filter((member) => member.status === "down").length;
  if (down === 0) return "operational";
  return down === known.length ? "outage" : "degraded";
}

/** A service's status and history from the monitors behind it. */
export function buildService(
  config: StatusMonitorConfig,
  monitors: readonly UrMonitor[],
  nowMs: number,
): ServiceUptime {
  const dates = historyDates(nowMs);
  const members = monitors.map((monitor) => memberHistory(monitor, nowMs));
  if (members.length === 0) {
    return {
      service: config.service,
      name: config.name,
      health: "unknown",
      days: dates.map((date) => ({ date, uptimePct: -1, hasIncident: false })),
      uptimePct: null,
      recentIncidents: [],
    };
  }

  const serviceDown = serviceDownIntervals(members, nowMs);
  const firstMonitoredMs = Math.min(...members.map((member) => member.createdMs));
  const allMemberDown = members.flatMap((member) => member.down);

  const days = dates.map((date): DayUptime => {
    const dayStart = Date.parse(`${date}T00:00:00.000Z`);
    const from = Math.max(dayStart, firstMonitoredMs);
    const to = Math.min(dayStart + DAY_MS, nowMs);
    if (from >= to) return { date, uptimePct: -1, hasIncident: false };
    const down = overlapMs(serviceDown, from, to);
    return {
      date,
      uptimePct: down === 0 ? 100 : Math.max(0, ((to - from - down) / (to - from)) * 100),
      hasIncident: overlaps(allMemberDown, from, to),
    };
  });

  const windowStart = Math.max(Date.parse(`${dates[0]}T00:00:00.000Z`), firstMonitoredMs);
  const monitored = nowMs - windowStart;
  const uptimePct = monitored > 0
    ? ((monitored - overlapMs(serviceDown, windowStart, nowMs)) / monitored) * 100
    : null;

  const recentIncidents = members
    .flatMap((member) =>
      member.logs
        .filter((log) => log.type === 1)
        .map((log): Omit<RecentIncident, "id"> & { startMs: number } => {
          const startMs = log.datetime * 1000;
          const endMs = log.duration > 0 ? startMs + log.duration * 1000 : nowMs;
          return {
            scope: members.length > 1 ? "server" : "service",
            cause: log.reason?.detail ?? null,
            startedAt: new Date(startMs).toISOString(),
            resolvedAt: log.duration > 0 ? new Date(endMs).toISOString() : null,
            serviceAffected: overlaps(serviceDown, startMs, endMs),
            startMs,
          };
        })
        .filter((incident) => incident.startMs >= windowStart || incident.resolvedAt === null),
    )
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, MAX_INCIDENTS)
    .map(({ startMs: _startMs, ...incident }, index) => ({ id: `${config.service}-${index}`, ...incident }));

  return {
    service: config.service,
    name: config.name,
    health: serviceHealth(members),
    days,
    uptimePct,
    recentIncidents,
  };
}

// ─── Main data fetcher ───────────────────────────────────────────────

async function urFetch(apiKey: string, params: Record<string, string>): Promise<UrResponse> {
  const body = new URLSearchParams({ api_key: apiKey, format: "json", ...params });
  const res = await fetch(`${BASE}/getMonitors`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`UptimeRobot ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as UrResponse;
  if (data.stat !== "ok") throw new Error(`UptimeRobot error: ${data.error?.message ?? "unknown"}`);
  return data;
}

/** Monitor ids from a comma-separated setting such as `"802910459,802911234"`. */
export function parseMonitorIds(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));
}

export async function fetchServiceUptime(
  apiKey: string,
  configs: readonly StatusMonitorConfig[],
  nowMs = Date.now(),
): Promise<ServiceUptime[]> {
  const ids = [...new Set(configs.flatMap((config) => config.monitorIds))];
  const monitors = ids.length > 0
    ? (await urFetch(apiKey, { monitors: ids.join("-"), logs: "1", logs_limit: "500" })).monitors ?? []
    : [];
  return configs.map((config) =>
    buildService(
      config,
      config.monitorIds.flatMap((id) => monitors.filter((monitor) => String(monitor.id) === id)),
      nowMs,
    ),
  );
}

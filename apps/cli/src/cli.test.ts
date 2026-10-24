import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "./cli.ts";

const VALID_ID_BODY = "0123456789abcdefghjkmnpqrs";
const SCHEDULE = {
  id: `schedule_${VALID_ID_BODY}`,
  title: "Quarterly Review",
  startsAt: "2026-07-21T14:00:00.000Z",
  endsAt: "2026-07-21T15:30:00.000Z", // 90 minutes
  timeZone: "Asia/Dhaka",
  state: "upcoming",
  revision: 3,
  spaceName: "Leadership",
};

/** A create response satisfying publicScheduleCreateResponseSchema. */
function createResponse(overrides: Record<string, unknown> = {}) {
  return {
    ...SCHEDULE,
    meetingLinkId: `link_${VALID_ID_BODY}`,
    code: "abc-defg-hij",
    reminderMinutesBefore: null,
    canceledAt: null,
    spaceId: null,
    attendeeCount: 0,
    ...overrides,
  };
}

const MEETING = {
  id: "meeting_x",
  title: "Standup",
  startedAt: "2026-07-21T14:00:00.000Z",
  endedAt: "2026-07-21T15:30:00.000Z",
  retainUntil: null,
  spaceName: null,
  participants: [],
};

const AVAILABLE = {
  summary: false,
  transcript: false,
  recordings: false,
  whiteboardPdf: false,
};

function recordOf(url: string | URL | Request, init: RequestInit) {
  return {
    url: new URL(String(url)),
    method: init.method ?? "GET",
    // Request bodies this CLI sends are always JSON.
    body: init.body ? JSON.parse(String(init.body)) : undefined,
    headers: init.headers ?? {},
  };
}

type RecordedRequest = ReturnType<typeof recordOf>;

let requests: RecordedRequest[];
let stdout: string[];
let stderr: string[];
let responder: (request: RecordedRequest) => Response;

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

beforeEach(() => {
  requests = [];
  stdout = [];
  stderr = [];
  process.env.ORBMEET_TOKEN = "test-token";
  responder = () => jsonResponse({ error: { code: "NOT_FOUND", message: "unexpected" } }, 404);
  vi.stubGlobal("fetch", (url: string | URL | Request, init: RequestInit = {}) => {
    const record = recordOf(url, init);
    requests.push(record);
    return Promise.resolve(responder(record));
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.ORBMEET_TOKEN;
  delete process.env.ORBMEET_TIMEZONE;
  process.exitCode = 0;
});

function emitted() {
  return JSON.parse(stdout.join(""));
}

function emittedError() {
  return JSON.parse(stderr.join(""));
}

describe("reschedule", () => {
  beforeEach(() => {
    responder = ({ method, body }) => method === "PATCH"
      ? jsonResponse({
          data: {
            ...SCHEDULE,
            startsAt: body.startsAt,
            timeZone: body.timeZone,
            revision: 4,
            reminderMinutesBefore: null,
          },
        })
      : jsonResponse({ data: SCHEDULE });
  });

  it("keeps the meeting's duration and zone unless overridden", async () => {
    await run(["reschedule", "Quarterly Review", "--at", "2026-07-22 10:00"]);
    const patch = requests.find((request) => request.method === "PATCH")!;
    expect(patch.body).toEqual({
      expectedRevision: 3,
      startsAt: "2026-07-22T04:00:00.000Z", // 10:00 Asia/Dhaka
      timeZone: "Asia/Dhaka",
      durationMinutes: 90,
    });
    expect(emitted().meeting.id).toBe(SCHEDULE.id);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("applies explicit --duration and --timezone overrides", async () => {
    await run([
      "reschedule", SCHEDULE.id,
      "--at", "2026-07-22 10:00", "--duration", "45", "--timezone", "America/New_York",
    ]);
    expect(requests[0].url.pathname).toBe(`/api/v1/schedules/${SCHEDULE.id}`);
    const patch = requests.find((request) => request.method === "PATCH")!;
    expect(patch.body.durationMinutes).toBe(45);
    expect(patch.body.timeZone).toBe("America/New_York");
    expect(patch.body.startsAt).toBe("2026-07-22T14:00:00.000Z");
  });

  it("--dry-run resolves the meeting and plans the change without a PATCH", async () => {
    await run(["reschedule", "Quarterly Review", "--at", "2026-07-22 10:00", "--dry-run"]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(emitted()).toMatchObject({
      status: "dry_run",
      action: "reschedule",
      meeting: { id: SCHEDULE.id, title: "Quarterly Review" },
      change: { startsAt: "2026-07-22T04:00:00.000Z", timeZone: "Asia/Dhaka", durationMinutes: 90 },
    });
  });
});

describe("cancel", () => {
  beforeEach(() => {
    responder = ({ method }) => method === "DELETE"
      ? jsonResponse({ data: { id: SCHEDULE.id, revision: 4, alreadyCanceled: false } })
      : jsonResponse({ data: SCHEDULE });
  });

  it("--dry-run shows the resolved target without deleting", async () => {
    await run(["cancel", "Quarterly Review", "--dry-run"]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(emitted()).toMatchObject({ status: "dry_run", action: "cancel", meeting: { id: SCHEDULE.id } });
  });

  it("cancels with the resolved revision and reports the id", async () => {
    await run(["cancel", "Quarterly Review", "--reason", "obsolete"]);
    expect(requests[0].url.searchParams.get("includeCanceled")).toBe("true");
    const del = requests.find((request) => request.method === "DELETE")!;
    expect(del.body).toEqual({ expectedRevision: 3, reason: "obsolete" });
    expect(emitted()).toMatchObject({ status: "canceled", meeting: { id: SCHEDULE.id } });
  });
});

describe("whoami", () => {
  it("reports the acting user, scopes, and time references", async () => {
    responder = () => jsonResponse({
      data: {
        user: {
          name: "Ana",
          email: "ana@example.com",
          plan: "pro",
          timeZone: "Asia/Dhaka",
        },
        tokenId: "pat_x",
        scopes: ["meetings:read"],
        serverTime: "2026-07-17T08:00:00.000Z",
      },
    });
    await run(["whoami"]);
    expect(requests[0].url.pathname).toBe("/api/v1/me");
    const output = emitted();
    expect(output).toMatchObject({
      user: { name: "Ana", email: "ana@example.com", plan: "pro" },
      scopes: ["meetings:read"],
      serverTime: "2026-07-17T08:00:00.000Z",
      homeTimeZone: "Asia/Dhaka",
      effectiveTimeZone: "Asia/Dhaka",
      timeZoneSource: "account",
    });
    expect(typeof output.machineTimeZone).toBe("string");
  });
});

describe("schedules", () => {
  it("follows every nextCursor instead of truncating at the first page", async () => {
    responder = ({ url }) => url.searchParams.get("cursor") === "page-2"
      ? jsonResponse({ data: [{ ...SCHEDULE, id: `${SCHEDULE.id}2` }], nextCursor: null })
      : jsonResponse({ data: [SCHEDULE], nextCursor: "page-2" });

    await run(["schedules"]);

    expect(requests).toHaveLength(2);
    expect(requests[1].url.searchParams.get("cursor")).toBe("page-2");
    expect(emitted().meetings).toHaveLength(2);
  });

  it("omits the join url for schedules whose code is null", async () => {
    responder = () => jsonResponse({ data: [{ ...SCHEDULE, code: null }], nextCursor: null });

    await run(["schedules"]);

    expect(emitted().meetings[0].joinUrl).toBeUndefined();
  });
});

describe("retrieve", () => {
  it("defaults to the summary only", async () => {
    responder = () => jsonResponse({
      data: { meeting: MEETING, available: AVAILABLE, summary: null },
    });
    await run(["retrieve", "Quarterly Review"]);
    expect(requests[0].url.searchParams.getAll("include")).toEqual(["summary"]);
  });
});

describe("schedule", () => {
  it("uses the account home time zone when no override is provided", async () => {
    responder = ({ url, method }) => url.pathname === "/api/v1/me"
      ? jsonResponse({
          data: {
            user: {
              name: "Ana",
              email: "ana@example.com",
              plan: "pro",
              timeZone: "Asia/Dhaka",
            },
            scopes: ["meetings:write"],
            serverTime: "2026-07-17T08:00:00.000Z",
          },
        })
      : method === "POST"
        ? jsonResponse({ data: createResponse() }, 201)
        : jsonResponse({}, 404);

    await run(["schedule", "--at", "2026-07-22 10:00"]);

    expect(requests.map((entry) => entry.url.pathname)).toEqual([
      "/api/v1/me",
      "/api/v1/schedules/",
    ]);
    expect(requests[1].body).toMatchObject({
      startsAt: "2026-07-22T04:00:00.000Z",
      timeZone: "Asia/Dhaka",
    });
    expect(emitted().timeZoneSource).toBe("account");
  });

  it("lets ORBMEET_TIMEZONE override the account without a profile lookup", async () => {
    process.env.ORBMEET_TIMEZONE = "America/New_York";
    responder = () => jsonResponse({ data: createResponse() }, 201);

    await run(["schedule", "--at", "2026-07-22 10:00"]);

    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({
      startsAt: "2026-07-22T14:00:00.000Z",
      timeZone: "America/New_York",
    });
    expect(emitted().timeZoneSource).toBe("environment");
  });

  it("reports when it has to fall back to the machine time zone", async () => {
    responder = ({ url, method }) => url.pathname === "/api/v1/me"
      ? jsonResponse({
          data: {
            user: {
              name: "Ana",
              email: "ana@example.com",
              plan: "pro",
              timeZone: null,
            },
            scopes: ["meetings:write"],
            serverTime: "2026-07-17T08:00:00.000Z",
          },
        })
      : method === "POST"
        ? jsonResponse({ data: createResponse() }, 201)
        : jsonResponse({}, 404);

    await run(["schedule", "--at", "2026-07-22T10:00:00Z"]);

    expect(emitted()).toMatchObject({
      timeZoneSource: "machine",
      warning: expect.stringContaining("No account home time zone is set"),
    });
  });

  it("returns the created meeting's id for later chaining", async () => {
    responder = ({ url, method }) => url.pathname === "/api/v1/me"
      ? jsonResponse({
          data: {
            user: { name: "Ana", email: "ana@example.com", plan: "pro", timeZone: "Asia/Dhaka" },
            scopes: ["meetings:write"],
            serverTime: "2026-07-17T08:00:00.000Z",
          },
        })
      : method === "POST"
        ? jsonResponse({ data: createResponse({ attendeeCount: 2 }) }, 201)
        : jsonResponse({}, 404);
    await run(["schedule", "--title", "Sync", "--at", "2026-07-22T10:00:00Z"]);
    expect(emitted().meeting.id).toBe(SCHEDULE.id);
    expect(emitted().meeting.joinUrl).toBe("https://orbmeet.com/abc-defg-hij");
    expect(emitted().meeting.space).toBe("Leadership"); // server-reported, not echoed input
  });

  it("rejects a contract-violating create response instead of printing a broken join URL", async () => {
    // The create contract always carries a join code; a null code is a
    // server bug the CLI now surfaces rather than papering over.
    responder = () => jsonResponse({ data: createResponse({ code: null }) }, 201);
    await run(["schedule", "--title", "Sync", "--at", "2026-07-22T10:00:00Z"]);
    expect(emittedError().error.message)
      .toBe("Orb Meet API returned an unexpected success response");
    expect(process.exitCode).toBe(1);
  });

  it("rejects positional words instead of silently dropping the title", async () => {
    await run(["schedule", "Standup", "--at", "2026-07-22T10:00:00Z"]);
    expect(requests).toHaveLength(0);
    expect(emittedError().error.message)
      .toBe('Unexpected argument "Standup". Run: orbmeet schedule --help');
    expect(process.exitCode).toBe(1);
  });
});

describe("help and errors", () => {
  it("prints command help for --help without touching the network", async () => {
    await run(["reschedule", "--help"]);
    expect(requests).toHaveLength(0);
    expect(stdout.join("")).toContain("Usage: orbmeet reschedule");
  });

  it("prints help even when an earlier value option is incomplete", async () => {
    await run(["schedule", "--title", "--help"]);
    expect(requests).toHaveLength(0);
    expect(stdout.join("")).toContain("Usage: orbmeet schedule");
    expect(stderr).toHaveLength(0);
  });

  it("prints API errors as JSON on stderr and exits 1", async () => {
    responder = () => jsonResponse({
      error: { code: "AMBIGUOUS_SCHEDULE", message: "More than one", details: { candidates: [] } },
    }, 409);
    await run(["cancel", "Standup"]);
    expect(stdout).toHaveLength(0);
    expect(emittedError().error).toMatchObject({ code: "AMBIGUOUS_SCHEDULE", details: { candidates: [] } });
    expect(process.exitCode).toBe(1);
  });

  it("suggests help for unknown commands", async () => {
    await run(["schdule"]);
    expect(emittedError().error.message).toBe("Unknown command: schdule. Run: orbmeet help");
    expect(process.exitCode).toBe(1);
  });

  it("prints command help for `version --help` instead of the version", async () => {
    await run(["version", "--help"]);
    expect(stdout.join("")).toContain("Usage: orbmeet version");
  });

  it("reports a clear error when the API responds with something that is not JSON", async () => {
    responder = () => new Response("<html>gateway</html>", { status: 200 });
    await run(["whoami"]);
    expect(emittedError().error.message)
      .toBe("Orb Meet API returned a response that is not JSON (status 200)");
    expect(process.exitCode).toBe(1);
  });

  it("reports a clear error for a wrong-shaped successful response", async () => {
    responder = () => jsonResponse({ data: null });
    await run(["whoami"]);
    expect(emittedError().error.message)
      .toBe("Orb Meet API returned an unexpected success response");
    expect(process.exitCode).toBe(1);
  });

  it("reports non-Error network rejections without crashing the error path", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(null));
    await run(["whoami"]);
    expect(emittedError().error.message)
      .toBe("Could not reach https://orbmeet.com (unknown network error)");
    expect(process.exitCode).toBe(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:workers";
import { meetingLinks, meetings, spaceMembers, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { TEST_MEDIA_ENV, TEST_MEDIA_NODE } from "@/test/nodes";
import { MemoryStorage } from "@/test/meeting-room-storage";
import type { CoordinatorReply, CoordinatorRequest, JoinReply } from "./api";

const livekit = vi.hoisted(() => ({
  updateParticipant: vi.fn(async () => ({})),
  removeParticipant: vi.fn(async () => undefined),
  listParticipants: vi.fn(async () => [] as Array<{ identity: string; sid: string; kind: number }>),
  listRooms: vi.fn(async () => []),
  updateRoomMetadata: vi.fn(async () => ({})),
  deleteRoom: vi.fn(async () => undefined),
  listEgress: vi.fn(async () => []),
  stopEgress: vi.fn(async () => ({})),
  startRoomCompositeEgress: vi.fn(async () => ({ egressId: "EG_1" })),
}));
vi.mock("@/platform/realtime/livekit-clients.server", () => ({
  createRoomServiceClient: () => livekit,
  createEgressClient: () => livekit,
}));

/** Holds the next placement until the test lets it go; passes every other one through. */
const placement = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
vi.mock("../room/media-placement.server", async (original) => {
  const actual = await original<typeof import("../room/media-placement.server")>();
  return {
    ...actual,
    choosePlacement: async (...args: Parameters<typeof actual.choosePlacement>) => {
      const held = placement.hold;
      placement.hold = null;
      if (held) await held;
      return actual.choosePlacement(...args);
    },
  };
});

const { MeetingRoomHost } = await import("./room.server");

let db: TestDb;
const T0 = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);

beforeEach(async () => {
  db = await createTestDb();
  d1.failures = { batches: 0, afterCommit: false };
  for (const mock of Object.values(livekit)) mock.mockClear();
  await db.insert(users).values(["host", "ada"].map((id) => ({
    id, name: id, email: `${id}@example.com`, normalizedEmail: `${id}@example.com`,
    plan: "free" as const, role: "user" as const, createdAt: T0, updatedAt: T0,
  })));
  await seedPersonalSpace(db, "host", { now: T0 });
  await db.insert(meetingLinks).values({
    id: "link_1", code: "abc-defg-hij", spaceId: "host_space", spaceKind: "personal",
    allowGuests: true, createdAt: T0, updatedAt: T0,
  });
  await db.insert(meetings).values({
    id: "meeting_1", meetingLinkId: "link_1", spaceId: "host_space", spaceKind: "personal",
    startedByUserId: "host", status: "open", billingPrincipalType: "user", billingPrincipalId: "host",
    billingPlan: "free", allowGuests: true, recordingEnabled: false, joinPolicy: "open",
    startedAt: T0, updatedAt: T0,
  });
});

const workflows = vi.hoisted(() => ({ create: vi.fn(async (_options: { id: string; params: unknown }) => ({})) }));

/**
 * D1, failing the next `failures.batches` batches: before they commit, or
 * after (`afterCommit`), as a reply lost on the way back does.
 */
const d1 = { failures: { batches: 0, afterCommit: false } };
const flakyD1 = () => new Proxy(testEnv.DB, {
  get(target, prop) {
    const value = Reflect.get(target, prop, target) as unknown;
    if (prop === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        if (d1.failures.batches === 0) return target.batch(statements);
        d1.failures.batches -= 1;
        if (d1.failures.afterCommit) await target.batch(statements);
        throw new Error("D1 unavailable");
      };
    }
    return typeof value === "function" ? value.bind(target) : value;
  },
});

const env = () => ({
  ...TEST_MEDIA_ENV,
  JOBS: { create: workflows.create, get: vi.fn(async () => ({})) },
  DB: flakyD1(),
  APP_URL: "https://app.test",
  ENVIRONMENT: "test",
  R2_BUCKET: { delete: vi.fn(async () => undefined) },
}) as unknown as Env;


/** A request to this test's meeting, which it addresses itself. */
type RoomRequest = CoordinatorRequest extends infer R ? R extends unknown ? Omit<R, "meetingId"> : never : never;

function room(storage = new MemoryStorage()) {
  const host = new MeetingRoomHost(env(), "meeting_1", storage);
  const send = (request: RoomRequest): Promise<CoordinatorReply> =>
    host.handle({ ...request, meetingId: "meeting_1" });
  return { host, storage, send };
}

const hostSubject = { kind: "user" as const, userId: "host" };
const ada = { kind: "user" as const, userId: "ada" };

async function join(
  send: ReturnType<typeof room>["send"],
  subject: { kind: "user"; userId: string },
  clientAttemptId: string = crypto.randomUUID(),
) {
  const reply = await send({
    kind: "join",
    join: {
      subject, admissionId: null, clientAttemptId, displayName: subject.userId,
      captionLanguage: "en-US", unreachableMediaUrl: null, nodeLatencies: {}, replacesAttemptId: null, newGuestSecretHash: null, guestNetworkKey: null,
    },
  });
  if (reply.kind !== "admitted") throw new Error(reply.kind);
  return reply as Extract<JoinReply, { kind: "admitted" }>;
}

const joined = (identity: string, sid: string) => ({
  kind: "observe" as const, nodeId: "test-node",
  observation: { kind: "participantJoined" as const, identity, sid, joinedAt: Date.now(), at: Date.now() },
});

describe("MeetingRoomHost", () => {
  it("runs a meeting from first join to a drained end", async () => {
    const { host, storage, send } = room();

    const hostJoin = await join(send, hostSubject);
    expect(hostJoin.token).toMatch(/^ey/);
    expect(hostJoin.participant.role).toBe("host");
    // D1 shows the attempt by the time the reply arrives.
    await expect(db.query.meetingConnections.findFirst({ where: { id: hostJoin.participant.attemptId } }))
      .resolves.toMatchObject({ connectionStatus: "pending", livekitIdentity: hostJoin.participant.identity });
    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" } }))
      .resolves.toMatchObject({ mediaNodeId: "test-node" });
    expect(storage.state).not.toBeNull();
    expect(storage.alarm).toEqual(expect.any(Number));

    await send(joined(hostJoin.participant.identity, "PA_h"));
    const adaJoin = await join(send, ada);
    await send(joined(adaJoin.participant.identity, "PA_a"));
    await send({
      kind: "command",
      command: { kind: "raiseHand", subject: ada, attemptId: adaJoin.participant.attemptId, raiseId: "r1" },
    });
    await host.idle();
    expect(livekit.updateParticipant).toHaveBeenCalledWith(
      "meet-meeting_1",
      adaJoin.participant.identity,
      expect.objectContaining({ attributes: expect.objectContaining({ "orbmeet.hand": expect.stringMatching(/^r1:/) }) }),
    );
    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" } }))
      .resolves.toMatchObject({ firstJoinedAt: expect.any(Date) });

    await send({ kind: "command", command: { kind: "end", subject: hostSubject, reason: "host" } });
    await host.idle();

    expect(livekit.deleteRoom).toHaveBeenCalledWith("meet-meeting_1");
    // What follows the end is handed to the meeting's follow-up jobs.
    expect(workflows.create.mock.calls.map(([options]) => options.id).sort()).toEqual([
      "capture-meeting_1-0",
      "contacts-meeting_1",
      "summary-after-end-meeting_1",
    ]);
    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" } })).resolves.toMatchObject({
      status: "ended",
      drainedAt: expect.any(Date),
    });
    await expect(db.query.meetingConnections.findMany({ where: { meetingId: "meeting_1" } }))
      .resolves.toSatisfy((rows: Array<{ connectionStatus: string }>) => rows.every((row) => row.connectionStatus === "ended"));
    // Drained: the room forgot the meeting.
    expect(storage.state).toBeNull();
    expect(storage.alarm).toBeNull();
  });

  it("applies concurrent requests one at a time, keeping every join", async () => {
    const { host, storage, send } = room();
    const ids = ["u1", "u2", "u3", "u4", "u5"];
    await db.insert(users).values(ids.map((id) => ({
      id, name: id, email: `${id}@example.com`, normalizedEmail: `${id}@example.com`,
      plan: "free" as const, role: "user" as const, createdAt: T0, updatedAt: T0,
    })));
    const joins = await Promise.all(ids.map((userId) => join(send, { kind: "user", userId })));
    await host.idle();

    const attempts = new Set(joins.map((reply) => reply.participant.attemptId));
    expect(attempts.size).toBe(5);
    const rows = await db.query.meetingConnections.findMany({ where: { meetingId: "meeting_1" } });
    expect(new Set(rows.map((row) => row.id))).toEqual(attempts);
    expect(Object.keys(storage.state!.attempts).sort()).toEqual([...attempts].sort());
  });

  it("keeps nothing new for a request that changes nothing", async () => {
    const { host, storage, send } = room();
    const hostJoin = await join(send, hostSubject);
    await send(joined(hostJoin.participant.identity, "PA_h"));
    await host.idle();
    const saves = storage.saves;
    await send({
      kind: "command",
      command: { kind: "listPending", subject: hostSubject },
    });
    // An event from a node the meeting does not live on is ignored.
    await send({
      kind: "observe", nodeId: "other-node",
      observation: { kind: "participantLeft", identity: hostJoin.participant.identity, sid: "PA_h", at: Date.now() },
    });
    expect(storage.saves).toBe(saves);
  });

  it("keeps removing an identity a webhook names until the removal lands", async () => {
    const { host, storage, send } = room();
    const hostJoin = await join(send, hostSubject);
    await send(joined(hostJoin.participant.identity, "PA_h"));
    await host.idle();
    livekit.removeParticipant.mockRejectedValueOnce(new Error("livekit down"));
    await send(joined("stranger_identity", "PA_x"));
    await host.idle();
    expect(storage.state!.room.strays).toEqual(["stranger_identity"]);

    // Evicted meanwhile: a fresh instance still owes the removal.
    const reloaded = new MeetingRoomHost(env(), "meeting_1", storage, { now: () => Date.now() + 60_000 });
    await reloaded.alarm();
    await reloaded.idle();
    expect(livekit.removeParticipant).toHaveBeenLastCalledWith("meet-meeting_1", "stranger_identity", expect.anything());
    expect(storage.state!.room.strays).toEqual([]);
  });

  it("keeps a change D1 missed and projects it before anything relies on it", async () => {
    const { host, storage, send } = room();
    d1.failures = { batches: 1, afterCommit: false };
    await expect(join(send, hostSubject, "tab-1")).rejects.toThrow("D1 unavailable");
    // The room kept the join, and what D1 last showed; D1 shows nothing yet.
    const [attemptId] = Object.keys(storage.state!.attempts);
    expect(storage.projectedFrom).toBeNull();
    await expect(db.query.meetingConnections.findFirst({ where: { id: attemptId } })).resolves.toBeUndefined();
    expect(livekit.updateRoomMetadata).not.toHaveBeenCalled();

    // The client's retry is the same attempt, and D1 catches up before the reply.
    const retried = await join(send, hostSubject, "tab-1");
    expect(retried.participant.attemptId).toBe(attemptId);
    await expect(db.query.meetingConnections.findFirst({ where: { id: attemptId } })).resolves.toBeDefined();
    expect(storage.projectedFrom).toBeUndefined();
    await host.idle();
  });

  it("redoes a projection whose reply was lost, after an eviction, without duplicating rows", async () => {
    const { storage, send } = room();
    const hostJoin = await join(send, hostSubject);
    await send(joined(hostJoin.participant.identity, "PA_h"));
    d1.failures = { batches: 1, afterCommit: true };
    await expect(send({ kind: "command", command: { kind: "end", subject: hostSubject, reason: "host" } }))
      .rejects.toThrow("D1 unavailable");
    expect(storage.state!.meta.phase).toBe("ended");
    expect(storage.projectedFrom?.meta.phase).toBe("live");

    const reloaded = new MeetingRoomHost(env(), "meeting_1", storage);
    await reloaded.alarm();
    await reloaded.idle();
    expect(storage.state).toBeNull();
    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" } }))
      .resolves.toMatchObject({ status: "ended", drainedAt: expect.any(Date) });
    await expect(db.query.meetingConnections.findMany({ where: { meetingId: "meeting_1" } }))
      .resolves.toEqual([expect.objectContaining({ id: hostJoin.participant.attemptId, connectionStatus: "ended" })]);
  });

  it("applies the grant a demotion calls for as soon as the grant it overtook lands", async () => {
    const { host, send } = room();
    const hostJoin = await join(send, hostSubject);
    await send(joined(hostJoin.participant.identity, "PA_h"));
    const adaJoin = await join(send, ada);
    await send(joined(adaJoin.participant.identity, "PA_a"));
    await host.idle();
    livekit.updateParticipant.mockClear();

    let land = () => {};
    livekit.updateParticipant.mockImplementationOnce(() => new Promise((resolve) => {
      land = () => resolve({});
    }));
    const moderator = (on: boolean) => send({
      kind: "command",
      command: { kind: "setModerator", subject: hostSubject, identity: adaJoin.participant.identity, moderator: on },
    });
    await moderator(true);
    await moderator(false);
    land();
    await host.idle();

    const grants = livekit.updateParticipant.mock.calls as unknown as Array<[string, string, { attributes: Record<string, string> }]>;
    expect(grants.map(([, , update]) => update.attributes["orbmeet.role"])).toEqual(["moderator", "attendee"]);
  });

  it("runs what came due when its alarm fires, even when nothing else changed", async () => {
    const { host, storage, send } = room();
    await join(send, hostSubject);
    await host.idle();
    livekit.listParticipants.mockClear();

    // A presence check is owed.
    storage.state!.room.lastPresenceCheckAt = 0;
    const reloaded = new MeetingRoomHost(env(), "meeting_1", storage);
    await reloaded.alarm();
    await reloaded.idle();
    expect(livekit.listParticipants).toHaveBeenCalledWith("meet-meeting_1");
  });

  it("creates its state from D1 on first contact, and refuses a meeting that has ended", async () => {
    const { storage, send } = room();
    await send({ kind: "wake" });
    expect(storage.state?.meta.meetingId).toBe("meeting_1");

    await db.update(meetings).set({ status: "ended", endedAt: new Date(), updatedAt: new Date() }).where(eq(meetings.id, "meeting_1"));
    const fresh = room();
    await expect(fresh.send({ kind: "wake" })).rejects.toMatchObject({ code: "MEETING_ENDED" });
    expect(fresh.storage.state).toBeNull();
  });

  it("judges every request by the Space authority it reads itself, not one the caller brought", async () => {
    const { send } = room();
    const hostJoin = await join(send, hostSubject);
    await send(joined(hostJoin.participant.identity, "PA_h"));
    // The host leaves their Space. A request already on its way names only them.
    await db.delete(spaceMembers).where(eq(spaceMembers.userId, "host"));
    await expect(send({
      kind: "command",
      command: { kind: "setCountdown", subject: { kind: "user", userId: "host" }, endsAt: Date.now() + 60_000 },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(db.query.meetingConnections.findFirst({ where: { id: hostJoin.participant.attemptId } }))
      .resolves.toMatchObject({ role: "attendee" });
  });

  it("throws refusals as AppErrors, with their code", async () => {
    const { send } = room();
    await expect(send({
      kind: "command",
      command: { kind: "setEgress", subject: ada, mode: "recording", on: true, target: null },
    })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("records an effect that failed and retries it after its backoff", async () => {
    const { host, storage, send } = room();
    livekit.updateRoomMetadata.mockRejectedValueOnce(new Error("livekit down"));
    const hostJoin = await join(send, hostSubject);
    await send(joined(hostJoin.participant.identity, "PA_h"));
    await send({
      kind: "command",
      command: { kind: "setCountdown", subject: hostSubject, endsAt: Date.now() + 60_000 },
    });
    await host.idle();
    expect(storage.state!.retries.metadata).toMatchObject({ failures: 1 });
    expect(storage.alarm).toBeLessThanOrEqual(storage.state!.retries.metadata.retryAt);
  });

  it("refuses a request still queued past its deadline, applying nothing", async () => {
    const { storage, send } = room();
    await expect(send({
      kind: "join",
      deadline: Date.now() - 1,
      join: {
        subject: hostSubject, admissionId: null, clientAttemptId: "late", displayName: "host",
        captionLanguage: "en-US", unreachableMediaUrl: null, nodeLatencies: {}, replacesAttemptId: null,
        newGuestSecretHash: null, guestNetworkKey: null,
      },
    })).rejects.toMatchObject({ code: "MEETING_BUSY", statusCode: 503 });
    expect(storage.saves).toBe(0);
  });

  it("places a meeting without holding up what else the meeting hears", async () => {
    const { send } = room();
    await join(send, hostSubject);
    let release!: () => void;
    placement.hold = new Promise<void>((resolve) => (release = resolve));

    // A join from a client that lost the node: placing it may take a probe's timeout.
    const moving = send({
      kind: "join",
      join: {
        subject: ada, admissionId: null, clientAttemptId: "moving", displayName: "ada",
        captionLanguage: "en-US", unreachableMediaUrl: TEST_MEDIA_NODE.url, nodeLatencies: {}, replacesAttemptId: null,
        newGuestSecretHash: null, guestNetworkKey: null,
      },
    });
    await vi.waitFor(() => expect(placement.hold).toBeNull());
    await expect(send({
      kind: "command",
      command: { kind: "setCountdown", subject: hostSubject, endsAt: Date.now() + 60_000 },
    })).resolves.toMatchObject({ kind: "ok" });

    release();
    await expect(moving).resolves.toMatchObject({ kind: "admitted" });
  });
});

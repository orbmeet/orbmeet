import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:workers";
import { meetingLinks, meetings, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedMeetingWhiteboard, seedPersonalSpace } from "@/test/fixtures";
import { snapshotMeta, installFakeSyncServer } from "@/test/fake-sync-server";
import { TEST_WHITEBOARD_D1_ENV } from "@/test/whiteboard-d1-env";
import { TEST_MEDIA_ENV } from "@/test/nodes";
import { MemoryStorage } from "@/test/meeting-room-storage";
import type { CoordinatorReply, CoordinatorRequest, JoinReply } from "./api";

const livekit = vi.hoisted(() => ({
  updateParticipant: vi.fn(async () => ({})),
  removeParticipant: vi.fn(async () => undefined),
  listParticipants: vi.fn(async () => [] as Array<{ identity: string; sid: string; kind: number }>),
  listRooms: vi.fn(async () => []),
  updateRoomMetadata: vi.fn(async (_room: string, _metadata: string) => ({})),
  deleteRoom: vi.fn(async () => undefined),
  listEgress: vi.fn(async () => []),
  stopEgress: vi.fn(async () => ({})),
  startRoomCompositeEgress: vi.fn(async () => ({ egressId: "EG_1" })),
}));
vi.mock("@/platform/realtime/livekit-clients.server", () => ({
  createRoomServiceClient: () => livekit,
  createEgressClient: () => livekit,
}));

const { MeetingRoomHost } = await import("./room.server");

let db: TestDb;
const T0 = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);

beforeEach(async () => {
  db = await createTestDb();
  for (const mock of Object.values(livekit)) mock.mockClear();
  await db.insert(users).values([{
    id: "host", name: "host", email: "host@example.com", normalizedEmail: "host@example.com",
    plan: "free" as const, role: "user" as const, createdAt: T0, updatedAt: T0,
  }]);
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
  for (const [id, index] of [["a", 1], ["b", 2]] as const) {
    await seedMeetingWhiteboard(db, {
      meetingId: "meeting_1", spaceId: "host_space",
      whiteboardId: `wb_${id}`, meetingWhiteboardId: `usage_${id}`,
      createdByUserId: "host", focused: false, now: new Date(T0.getTime() + index),
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = () => ({
  ...TEST_MEDIA_ENV,
  ...TEST_WHITEBOARD_D1_ENV,
  JOBS: { create: vi.fn(async () => ({})), get: vi.fn(async () => ({})) },
  DB: testEnv.DB,
  APP_URL: "https://app.test",
  ENVIRONMENT: "test",
  R2_BUCKET: { delete: vi.fn(async () => undefined) },
}) as unknown as Env;


type RoomRequest = CoordinatorRequest extends infer R ? R extends unknown ? Omit<R, "meetingId"> : never : never;

const hostSubject = { kind: "user" as const, userId: "host" };
const focus = (id: "a" | "b") => ({ usageId: `usage_${id}`, whiteboardId: `wb_${id}`, syncRoomId: `wb_${id}` });

async function openRoom() {
  const clock = { now: Date.now() };
  const host = new MeetingRoomHost(env(), "meeting_1", new MemoryStorage(), { now: () => clock.now });
  const send = (request: RoomRequest): Promise<CoordinatorReply> => host.handle({ ...request, meetingId: "meeting_1" });
  const reply = await send({
    kind: "join",
    join: {
      subject: hostSubject, admissionId: null, clientAttemptId: "c1", displayName: "host",
      captionLanguage: "en-US", unreachableMediaUrl: null, nodeLatencies: {}, replacesAttemptId: null, newGuestSecretHash: null, guestNetworkKey: null,
    },
  });
  if (reply.kind !== "admitted") throw new Error(reply.kind);
  const { identity } = (reply as Extract<JoinReply, { kind: "admitted" }>).participant;
  await send({
    kind: "observe", nodeId: "test-node",
    observation: { kind: "participantJoined", identity, sid: "PA_h", joinedAt: Date.now(), at: Date.now() },
  });
  await host.idle();
  return { host, send, clock };
}

function lastRoomSurface() {
  const calls = livekit.updateRoomMetadata.mock.calls;
  return (JSON.parse(calls[calls.length - 1][1]) as { surface: unknown }).surface;
}

async function surfaceRow() {
  return db.query.meetingWhiteboardSurfaces.findFirst({
    where: { meetingId: "meeting_1" },
    columns: { open: true, revision: true },
  });
}

async function focusedUsage() {
  return (await db.query.meetingWhiteboards.findMany({ where: { meetingId: "meeting_1" } }))
    .filter((usage) => usage.focusedAt !== null)
    .map((usage) => usage.id);
}

describe("the shared surface, through the meeting's room", () => {
  it("projects open, focus and switches to D1 and room metadata in one ordered record", async () => {
    const { host, send } = await openRoom();

    await send({ kind: "command", command: { kind: "setSurface", subject: hostSubject, open: true, fallback: focus("a") } });
    await host.idle();
    await expect(surfaceRow()).resolves.toEqual({ open: true, revision: 1 });
    await expect(focusedUsage()).resolves.toEqual(["usage_a"]);
    expect(lastRoomSurface()).toEqual({ open: true, whiteboardId: "wb_a", revision: 1, openRevision: 1 });

    installFakeSyncServer({
      capture: ({ toKey }) => ({ ok: true, copy: snapshotMeta(toKey, { documentClock: 5 }) }),
    });
    await send({ kind: "command", command: { kind: "present", subject: hostSubject, focus: focus("b") } });
    await host.idle();
    await expect(surfaceRow()).resolves.toEqual({ open: true, revision: 2 });
    await expect(focusedUsage()).resolves.toEqual(["usage_b"]);
    expect(lastRoomSurface()).toEqual({ open: true, whiteboardId: "wb_b", revision: 2, openRevision: 1 });
    // What board A showed was pinned once focus left it.
    const leftBoard = await db.query.meetingWhiteboards.findFirst({ where: { id: "usage_a" } });
    expect(leftBoard?.lastSharedSnapshotR2Key).toMatch(/canvases\/wb_a\/wbpin-2-usage_a\.json$/);
  });

  it("closes at once while the sync server is down, and pins once it is back", async () => {
    const { host, send, clock } = await openRoom();
    await send({ kind: "command", command: { kind: "setSurface", subject: hostSubject, open: true, fallback: focus("a") } });
    await host.idle();

    // No sync server: every command fails to reach it.
    installFakeSyncServer({});
    const closed = await send({ kind: "command", command: { kind: "setSurface", subject: hostSubject, open: false, fallback: null } });
    expect(closed).toMatchObject({ kind: "surface", surface: { open: false, revision: 2 } });
    await host.idle();
    await expect(surfaceRow()).resolves.toEqual({ open: false, revision: 2 });
    const unpinned = await db.query.meetingWhiteboards.findFirst({ where: { id: "usage_a" } });
    expect(unpinned?.lastSharedSnapshotR2Key).toBeNull();

    installFakeSyncServer({
      capture: ({ toKey }) => ({ ok: true, copy: snapshotMeta(toKey) }),
    });
    // The pin is retried once its backoff passes.
    clock.now += 60_000;
    await send({ kind: "wake" });
    await host.idle();
    const retried = await db.query.meetingWhiteboards.findFirst({ where: { id: "usage_a" } });
    expect(retried?.lastSharedSnapshotR2Key).toMatch(/canvases\/wb_a\/wbpin-2-usage_a\.json$/);
  });
});

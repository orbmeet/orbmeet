import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:workers";
import { WebhookEvent } from "livekit-server-sdk";
import { meetingLinks, meetings, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { TEST_MEDIA_ENV, TEST_MEDIA_NODE } from "@/test/nodes";
import { MemoryStorage } from "@/test/meeting-room-storage";
import type { CoordinatorRequest, JoinReply } from "@/modules/meetings/server/runtime/api";

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

// The meeting's coordinator, reached in-process: the webhook path runs as in
// production up to LiveKit itself.
const coordinator = vi.hoisted(() => ({ handle: null as null | ((request: unknown) => Promise<unknown>) }));
vi.mock("@/modules/meetings/server/runtime/client.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/meetings/server/runtime/client.server")>()),
  callCoordinator: (_env: Env, request: unknown) => coordinator.handle!(request),
}));

const { MeetingRoomHost } = await import("@/modules/meetings/server/runtime/room.server");
const { forwardLivekitWebhookEvent } = await import("./-webhook.server");

let db: TestDb;
const T0 = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
const env = {
  ...TEST_MEDIA_ENV,
  JOBS: { create: vi.fn(async () => ({})), get: vi.fn(async () => ({})) },
  DB: testEnv.DB,
  APP_URL: "https://app.test",
  ENVIRONMENT: "test",
  R2_BUCKET: { delete: vi.fn(async () => undefined) },
} as unknown as Env;

beforeEach(async () => {
  db = await createTestDb();
  for (const mock of Object.values(livekit)) mock.mockClear();
  await db.insert(users).values({
    id: "host", name: "host", email: "host@example.com", normalizedEmail: "host@example.com",
    plan: "free", role: "user", createdAt: T0, updatedAt: T0,
  });
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

type RoomRequest = CoordinatorRequest extends infer R ? R extends unknown ? Omit<R, "meetingId"> : never : never;

/** A meeting a participant joined, then the host ended and its room drained. */
async function endedMeeting() {
  const host = new MeetingRoomHost(env, "meeting_1", new MemoryStorage());
  coordinator.handle = (request) => host.handle(request as CoordinatorRequest);
  const send = (request: RoomRequest) => host.handle({ ...request, meetingId: "meeting_1" });
  const reply = await send({
    kind: "join",
    join: {
      subject: { kind: "user", userId: "host" }, admissionId: null, clientAttemptId: crypto.randomUUID(),
      displayName: "host", captionLanguage: "en-US", unreachableMediaUrl: null, nodeLatencies: {}, replacesAttemptId: null,
      newGuestSecretHash: null, guestNetworkKey: null,
    },
  }) as Extract<JoinReply, { kind: "admitted" }>;
  const identity = reply.participant.identity;
  await send({
    kind: "observe", nodeId: TEST_MEDIA_NODE.id,
    observation: { kind: "participantJoined", identity, sid: "PA_original", joinedAt: Date.now(), at: Date.now() },
  });
  await host.idle();
  await send({ kind: "command", command: { kind: "end", subject: { kind: "user", userId: "host" }, reason: "host" } });
  await host.idle();
  livekit.deleteRoom.mockClear();
  return { host, identity };
}

/** An event as WebhookReceiver makes it, from the webhook's JSON. */
const webhookEvent = (event: string, participant: Record<string, unknown>) => WebhookEvent.fromJson({
  event,
  createdAt: String(Math.floor(Date.now() / 1000)),
  room: { name: "meet-meeting_1", sid: "RM_1" },
  participant: { kind: "STANDARD", ...participant },
});

const joinedEvent = (identity: string) => webhookEvent("participant_joined", { identity, sid: "PA_after_end" });

describe("a participant who joins after their meeting is over", () => {
  it("has the recreated room closed on the node that reported it", async () => {
    const { identity } = await endedMeeting();
    expect((await db.query.meetings.findFirst({ where: { id: "meeting_1" } }))?.drainedAt).not.toBeNull();

    // A cached token the node still accepts recreates the room.
    await forwardLivekitWebhookEvent(joinedEvent(identity), TEST_MEDIA_NODE, env);

    expect(livekit.deleteRoom).toHaveBeenCalledWith("meet-meeting_1");
  });
});

describe("a participant's departure", () => {
  it("is logged with LiveKit's reason", async () => {
    const { identity } = await endedMeeting();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await forwardLivekitWebhookEvent(
        webhookEvent("participant_left", { identity, sid: "PA_original", disconnectReason: "CONNECTION_TIMEOUT" }),
        TEST_MEDIA_NODE,
        env,
      );
      const lines = info.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(lines).toContainEqual(expect.objectContaining({
        msg: "[livekit] participant_left",
        node: TEST_MEDIA_NODE.id,
        identity,
        reason: "CONNECTION_TIMEOUT",
      }));
    } finally {
      info.mockRestore();
    }
  });
});

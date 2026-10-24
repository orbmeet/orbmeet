import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { meetingAdmissions, meetingConnections, meetings, meetingLinks, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import {
  findActiveConnectionByUserId,
  findWhiteboardEligibleConnectionById,
} from "./connection-queries";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertUser(id: string) {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertMeeting(meetingId: string, ownerUserId: string) {
  const now = new Date();
  await seedPersonalSpace(db, ownerUserId);
  await db.insert(meetingLinks).values({
    id: `room_${meetingId}`,
    code: "abc-defg-hij",
    reusePolicy: "reusable",
    spaceId: `${ownerUserId}_space`,
    spaceKind: "personal" as const,
    title: "Meeting",
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, ownerUserId);
  await db.insert(meetings).values({
    id: meetingId,
    meetingLinkId: `room_${meetingId}`,
    startedByUserId: ownerUserId,
    spaceId: `${ownerUserId}_space`,
    spaceKind: "personal" as const,
    title: "Meeting",
    status: "open",
    billingPrincipalType: "user" as const,
    billingPrincipalId: ownerUserId,
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    endedAt: null,
    updatedAt: now,
  });
}

async function insertAdmission(id: string, meetingId: string, userId: string | null) {
  const now = new Date();
  await db.insert(meetingAdmissions).values({
    id,
    meetingId: meetingId,
    subjectType: userId ? "user" : "guest",
    subjectUserId: userId,
    guestSecretHash: userId ? null : "guest_secret_hash_hash",
    displayName: userId ?? "Guest",
    admissionStatus: "approved",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

async function insertConnection(input: {
  id: string;
  meetingId: string;
  userId: string | null;
  status: "pending" | "live" | "ended";
  tokenIssuedAt: Date;
  connectedAt?: Date | null;
  disconnectedAt?: Date | null;
}) {
  const admissionId = `mad_${input.id}`;
  await insertAdmission(admissionId, input.meetingId, input.userId);
  await db.insert(meetingConnections).values({
    id: input.id,
    meetingId: input.meetingId,
    admissionId,
    livekitIdentity: `${input.userId ?? "guest"}_${input.id}`,
    livekitParticipantSid: input.status === "pending" ? null : `PA_${input.id}`,
    userId: input.userId,
    role: "attendee",
    connectionStatus: input.status,
    reason: input.status === "ended" ? "network" : null,
    tokenIssuedAt: input.tokenIssuedAt,
    connectedAt: input.connectedAt ?? null,
    disconnectedAt: input.disconnectedAt ?? null,
    lastWebhookAt: input.status === "pending" ? null : (input.disconnectedAt ?? input.connectedAt ?? input.tokenIssuedAt),
    createdAt: input.tokenIssuedAt,
    updatedAt: input.disconnectedAt ?? input.connectedAt ?? input.tokenIssuedAt,
  });
}

describe("findActiveConnectionByUserId", () => {
  it("returns an active connection even when a newer disconnected row exists", async () => {
    await insertUser("host");
    await insertUser("member");
    await insertMeeting("meeting_1", "host");
    await insertAdmission("mad_connected", "meeting_1", "member");
    await insertAdmission("mad_disconnected", "meeting_1", "member");

    const now = new Date();
    const stillConnectedTokenIssuedAt = new Date(now.getTime() - 40_000);
    const staleDisconnectedAt = new Date(now.getTime() - 5_000);

    await db.insert(meetingConnections).values([
      {
        id: "mlp_connected",
        meetingId: "meeting_1",
        admissionId: "mad_connected",
        livekitIdentity: "member_ptc_connected",
        livekitParticipantSid: "PA_connected",
        userId: "member",
        role: "attendee",
        connectionStatus: "live",
        reason: null,
        tokenIssuedAt: stillConnectedTokenIssuedAt,
        connectedAt: stillConnectedTokenIssuedAt,
        disconnectedAt: null,
        lastWebhookAt: stillConnectedTokenIssuedAt,
        createdAt: stillConnectedTokenIssuedAt,
        updatedAt: stillConnectedTokenIssuedAt,
      },
      {
        id: "mlp_disconnected_newer",
        meetingId: "meeting_1",
        admissionId: "mad_disconnected",
        livekitIdentity: "member_ptc_disconnected",
        livekitParticipantSid: "PA_disconnected",
        userId: "member",
        role: "attendee",
        connectionStatus: "ended",
        reason: "left",
        tokenIssuedAt: new Date(now.getTime() - 9_000),
        connectedAt: new Date(now.getTime() - 9_000),
        disconnectedAt: staleDisconnectedAt,
        lastWebhookAt: staleDisconnectedAt,
        createdAt: new Date(now.getTime() - 10_000),
        updatedAt: staleDisconnectedAt,
      },
    ]);

    const connection = await findActiveConnectionByUserId(db, "meeting_1", "member");
    expect(connection).toMatchObject({
      connectionId: "mlp_connected",
      livekitIdentity: "member_ptc_connected",
      userId: "member",
      role: "attendee",
    });
  });

  it("keeps a connected row valid even when tokenIssuedAt is old", async () => {
    await insertUser("host");
    await insertUser("member");
    await insertMeeting("meeting_2", "host");
    await insertAdmission("mad_old_connected", "meeting_2", "member");

    const now = new Date();
    const connectedAt = new Date(now.getTime() - 20 * 60_000);

    await db.insert(meetingConnections).values({
      id: "mlp_old_connected",
      meetingId: "meeting_2",
      admissionId: "mad_old_connected",
      livekitIdentity: "member_ptc_old_connected",
      livekitParticipantSid: "PA_old_connected",
      userId: "member",
      role: "attendee",
      connectionStatus: "live",
      reason: null,
      tokenIssuedAt: connectedAt,
      connectedAt,
      disconnectedAt: null,
      lastWebhookAt: connectedAt,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    });

    const connection = await findActiveConnectionByUserId(db, "meeting_2", "member");
    expect(connection?.connectionId).toBe("mlp_old_connected");
  });

  // The meeting's room ends a token that never reached LiveKit once its look
  // at the room misses it; until then a late or lost join report must not
  // cost the participant their access.
  it("keeps an issued row active however old, until the meeting's room ends it", async () => {
    await insertUser("host");
    await insertUser("member");
    await insertMeeting("meeting_3", "host");

    const now = new Date();
    await insertConnection({
      id: "mlp_stale_token",
      meetingId: "meeting_3",
      userId: "member",
      status: "pending",
      tokenIssuedAt: new Date(now.getTime() - 61_000),
    });

    const connection = await findActiveConnectionByUserId(db, "meeting_3", "member");
    expect(connection?.connectionId).toBe("mlp_stale_token");
  });
});

describe("findWhiteboardEligibleConnectionById", () => {
  it("does not allow a disconnected connection to authorize whiteboard", async () => {
    await insertUser("host");
    await insertUser("member");
    await insertMeeting("meeting_4", "host");
    await insertAdmission("mad_recent_disconnect", "meeting_4", "member");

    const now = new Date();
    const connectedAt = new Date(now.getTime() - 30_000);
    const disconnectedAt = new Date(now.getTime() - 5_000);

    await db.insert(meetingConnections).values({
      id: "mlp_recent_disconnect",
      meetingId: "meeting_4",
      admissionId: "mad_recent_disconnect",
      livekitIdentity: "member_ptc_recent_disconnect",
      livekitParticipantSid: "PA_recent_disconnect",
      userId: "member",
      role: "attendee",
      connectionStatus: "ended",
      reason: "network",
      tokenIssuedAt: connectedAt,
      connectedAt,
      disconnectedAt,
      lastWebhookAt: disconnectedAt,
      createdAt: connectedAt,
      updatedAt: disconnectedAt,
    });

    const connection = await findWhiteboardEligibleConnectionById(
      db,
      "meeting_4",
      "mlp_recent_disconnect",
    );

    expect(connection).toBeNull();
  });

  it("lets an issued row authorize whiteboard however late its join is reported", async () => {
    await insertUser("host");
    await insertUser("member");
    await insertMeeting("meeting_5", "host");

    const now = new Date();
    await insertConnection({
      id: "mlp_whiteboard_token",
      meetingId: "meeting_5",
      userId: "member",
      status: "pending",
      tokenIssuedAt: new Date(now.getTime() - 90_000),
    });

    const connection = await findWhiteboardEligibleConnectionById(
      db,
      "meeting_5",
      "mlp_whiteboard_token",
    );

    expect(connection?.connectionId).toBe("mlp_whiteboard_token");
  });

  // A joiner holds valid credentials before LiveKit's participant_joined
  // webhook lands. Denying the whiteboard during that window raced the webhook
  // and left the surface blank — or, once the sync socket was refused, showed
  // "Whiteboard unavailable" with no recovery.
  it("allows a freshly issued token_issued row inside the join grace window", async () => {
    await insertUser("host");
    await insertUser("member");
    await insertMeeting("meeting_5b", "host");

    const now = new Date();
    await insertConnection({
      id: "mlp_whiteboard_joining",
      meetingId: "meeting_5b",
      userId: "member",
      status: "pending",
      tokenIssuedAt: new Date(now.getTime() - 1_000),
    });

    const connection = await findWhiteboardEligibleConnectionById(
      db,
      "meeting_5b",
      "mlp_whiteboard_joining",
    );

    expect(connection?.connectionId).toBe("mlp_whiteboard_joining");
  });

  it("still refuses a connection whose admission was revoked mid-join", async () => {
    await insertUser("host");
    await insertUser("member");
    await insertMeeting("meeting_5c", "host");

    const now = new Date();
    await insertConnection({
      id: "mlp_whiteboard_revoked",
      meetingId: "meeting_5c",
      userId: "member",
      status: "pending",
      tokenIssuedAt: new Date(now.getTime() - 1_000),
    });
    await db
      .update(meetingAdmissions)
      .set({ admissionStatus: "revoked" })
      .where(eq(meetingAdmissions.id, "mad_mlp_whiteboard_revoked"));

    const connection = await findWhiteboardEligibleConnectionById(
      db,
      "meeting_5c",
      "mlp_whiteboard_revoked",
    );

    expect(connection).toBeNull();
  });

  it("allows connected rows even when tokenIssuedAt is old", async () => {
    await insertUser("host");
    await insertUser("member");
    await insertMeeting("meeting_6", "host");

    const now = new Date();
    await insertConnection({
      id: "mlp_connected_whiteboard",
      meetingId: "meeting_6",
      userId: "member",
      status: "live",
      tokenIssuedAt: new Date(now.getTime() - 20 * 60_000),
      connectedAt: new Date(now.getTime() - 20 * 60_000),
    });

    const connection = await findWhiteboardEligibleConnectionById(
      db,
      "meeting_6",
      "mlp_connected_whiteboard",
    );

    expect(connection?.connectionId).toBe("mlp_connected_whiteboard");
  });
});

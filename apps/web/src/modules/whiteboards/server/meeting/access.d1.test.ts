import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  meetingAdmissions,
  meetingConnections,
  meetings,
  meetingLinks,
  spaceMembers,
  spaces,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedMeetingWhiteboard, seedPersonalSpace } from "@/test/fixtures";
import type { MeetingRole } from "@/modules/meetings/contract/constants";
import {
  areWhiteboardCapabilitiesStillAllowed,
  canAccessWhiteboardAsRecorder,
  getActiveWhiteboardParticipantAccess,
  lookupWhiteboardParticipantAccess,
  lookupWhiteboardSocketAccess,
  lookupWhiteboardSocketAccesses,
} from "@/modules/whiteboards/server/meeting/access";
import {
  canActiveParticipantReadWhiteboardAsset,
} from "@/modules/whiteboards/server/meeting/asset-access";
import { canUserReadWhiteboardDocument } from "@/modules/whiteboards/server/documents";
import { classifyWhiteboardAccessValidation } from "@/modules/whiteboards/server/http/room-authority";
import { resolveWhiteboardCapabilities } from "@/modules/whiteboards/server/meeting/grants";
import { whiteboardCapabilitiesForMeetingRole } from "@/modules/whiteboards/server/meeting/role";

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
    id: `link_${meetingId}`,
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
    meetingLinkId: `link_${meetingId}`,
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
    activeEgressId: null,
    updatedAt: now,
  });
}

// Mirrors the end CAS in finalize.ts; the schema CHECK constraints enforce
// this shape (endedAt set, active egress ids cleared).
async function endMeeting(meetingId: string) {
  const now = new Date();
  await db
    .update(meetings)
    .set({
      status: "ended",
      endedAt: now,
      updatedAt: now,
      activeEgressId: null,
      activeStreamEgressId: null,
    })
    .where(eq(meetings.id, meetingId));
}

async function insertConnection(input: {
  id: string;
  meetingId: string;
  userId: string | null;
  role: MeetingRole;
  // The explicit meeting-local moderator grant, independent of `role` (which is
  // only the derived cache — a space-authority moderator has role="moderator"
  // with no grant).
  meetingModerator?: boolean;
}) {
  const now = new Date();
  await db.insert(meetingAdmissions).values({
    id: `admission_${input.id}`,
    meetingId: input.meetingId,
    subjectType: input.userId ? "user" : "guest",
    subjectUserId: input.userId,
    guestSecretHash: input.userId ? null : "guest-secret-hash",
    displayName: input.userId ?? "Guest",
    meetingModerator: input.meetingModerator ?? false,
    admissionStatus: "approved",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetingConnections).values({
    id: input.id,
    meetingId: input.meetingId,
    admissionId: `admission_${input.id}`,
    livekitIdentity: input.userId ? `${input.userId}_identity` : `guest_${input.id}`,
    livekitParticipantSid: `sid_${input.id}`,
    userId: input.userId,
    role: input.role,
    connectionStatus: "live",
    reason: null,
    tokenIssuedAt: now,
    connectedAt: now,
    disconnectedAt: null,
    lastWebhookAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

describe("whiteboard active participant access", () => {
  it("does not authorize live-document assets through an ended meeting", async () => {
    await insertUser("owner");
    await insertUser("participant");
    await insertMeeting("meeting_asset", "owner");
    const { whiteboardId } = await seedMeetingWhiteboard(db, {
      meetingId: "meeting_asset",
      spaceId: "owner_space",
    });
    await insertConnection({
      id: "connection_asset",
      meetingId: "meeting_asset",
      userId: "participant",
      role: "attendee",
    });

    await expect(
      canUserReadWhiteboardDocument(db, whiteboardId, "participant"),
    ).resolves.toBe(true);
    // Deliberately leave the connection row live to verify that document-read
    // authorization independently requires an open Meeting.
    await endMeeting("meeting_asset");
    await expect(
      canUserReadWhiteboardDocument(db, whiteboardId, "participant"),
    ).resolves.toBe(false);
  });

  it("treats an active participant's stale document token as refreshable", () => {
    expect(classifyWhiteboardAccessValidation({
      lookup: "seated",
      identityStillAllowed: true,
      documentChanged: true,
      roleStillAllowed: true,
      capabilitiesStillAllowed: true,
    })).toBe("refresh");
  });

  it("does not make a revoked participant refreshable", () => {
    expect(classifyWhiteboardAccessValidation({
      lookup: "seated",
      identityStillAllowed: false,
      documentChanged: true,
      roleStillAllowed: true,
      capabilitiesStillAllowed: true,
    })).toBe("denied");
  });

  // A LiveKit reconnect issues a new connection id while the participant never
  // leaves. FORBIDDEN is terminal in the client socket adapter, so answering it
  // here left the whiteboard permanently dead for a healthy participant.
  it("treats a superseded connection lease as refreshable", () => {
    expect(classifyWhiteboardAccessValidation({ lookup: "retired" })).toBe("refresh");
  });

  it("keeps a closed meeting terminal", () => {
    expect(classifyWhiteboardAccessValidation({ lookup: "unauthorized" })).toBe("denied");
  });

  it("accepts a token that still matches current authority", () => {
    expect(classifyWhiteboardAccessValidation({
      lookup: "seated",
      identityStillAllowed: true,
      documentChanged: false,
      roleStillAllowed: true,
      capabilitiesStillAllowed: true,
    })).toBe("active");
  });

  it("projects a socket's complete current authority in one lookup", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "host_conn",
      meetingId: "meeting_1",
      userId: "host",
      role: "host",
    });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "board_a",
      meetingId: "meeting_1",
      spaceId: "host_space",
      title: "Board A",
      now: new Date(),
    });

    await expect(
      lookupWhiteboardSocketAccess(db, "board_a", "host_conn"),
    ).resolves.toMatchObject({
      status: "seated",
      documentChanged: false,
      access: {
        participantIdentity: "host_identity",
        role: "participant",
        capabilities: {
          canEditWhiteboard: true,
          canControlSurface: true,
          canManageWhiteboard: true,
        },
      },
    });
    await expect(
      lookupWhiteboardSocketAccess(db, "board_a", "host_conn", "board_other"),
    ).resolves.toMatchObject({ status: "seated", documentChanged: true });
  });

  it("answers every socket of a room in one batch, in request order", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await insertConnection({ id: "host_conn", meetingId: "meeting_1", userId: "host", role: "host" });
    await insertConnection({ id: "guest_conn", meetingId: "meeting_1", userId: null, role: "attendee" });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "board_a",
      meetingId: "meeting_1",
      spaceId: "host_space",
      title: "Board A",
      now: new Date(),
    });
    // More sockets than one statement's bound parameters allow.
    const strangers = Array.from({ length: 120 }, (_, index) => ({ connectionId: `missing_${index}` }));

    const lookups = await lookupWhiteboardSocketAccesses(db, "board_a", [
      { connectionId: "guest_conn" },
      ...strangers,
      { connectionId: "host_conn", documentId: "board_other" },
    ]);

    expect(lookups).toHaveLength(122);
    expect(lookups[0]).toMatchObject({ status: "seated", access: { participantIdentity: "guest_guest_conn" } });
    expect(lookups.slice(1, 121).every((lookup) => lookup.status === "unauthorized")).toBe(true);
    expect(lookups[121]).toMatchObject({
      status: "seated",
      documentChanged: true,
      access: { participantIdentity: "host_identity" },
    });
  });

  it("marks a stale document or retired connection as refreshable state", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "host_conn",
      meetingId: "meeting_1",
      userId: "host",
      role: "host",
    });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "board_a",
      meetingWhiteboardId: "usage_a",
      meetingId: "meeting_1",
      spaceId: "host_space",
      title: "Board A",
      focused: false,
      now: new Date(Date.now() - 1_000),
    });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "board_b",
      meetingWhiteboardId: "usage_b",
      meetingId: "meeting_1",
      spaceId: "host_space",
      title: "Board B",
      now: new Date(),
    });

    await expect(
      lookupWhiteboardSocketAccess(db, "board_a", "host_conn"),
    ).resolves.toMatchObject({ status: "seated", documentChanged: true });

    await db
      .update(meetingConnections)
      .set({ connectionStatus: "ended", disconnectedAt: new Date() })
      .where(eq(meetingConnections.id, "host_conn"));
    await expect(
      lookupWhiteboardSocketAccess(db, "board_a", "host_conn"),
    ).resolves.toEqual({ status: "retired" });
  });

  it("allows an active participant to read an asset without resolving moderator authority", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "host_conn",
      meetingId: "meeting_1",
      userId: "host",
      role: "host",
    });

    await expect(
      canActiveParticipantReadWhiteboardAsset(db, {
        meetingId: "meeting_1",
        connectionId: "host_conn",
        participantIdentity: "host_identity",
      }),
    ).resolves.toBe(true);
  });

  it("allows an approved active guest to read an asset in a Space-backed meeting", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "guest_conn",
      meetingId: "meeting_1",
      userId: null,
      role: "attendee",
    });

    await expect(
      canActiveParticipantReadWhiteboardAsset(db, {
        meetingId: "meeting_1",
        connectionId: "guest_conn",
        participantIdentity: "guest_guest_conn",
      }),
    ).resolves.toBe(true);
  });

  it("admits a signed-in attendee of a personal meeting on the same authority as a guest", async () => {
    // A personal Space has exactly one member, its owner, so Space `canView`
    // there means "is the owner" and can never describe an admitted attendee.
    // Requiring it made a personal meeting's own invited attendees fail while
    // its guests passed. Shared-Space revocation is asserted separately, in
    // asset-access.d1.test.ts.
    await insertUser("host");
    await insertUser("invited");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "invited_conn",
      meetingId: "meeting_1",
      userId: "invited",
      role: "attendee",
    });

    await expect(
      canActiveParticipantReadWhiteboardAsset(db, {
        meetingId: "meeting_1",
        connectionId: "invited_conn",
        participantIdentity: "invited_identity",
      }),
    ).resolves.toBe(true);
  });

  it("denies an asset read after admission revocation", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "host_conn",
      meetingId: "meeting_1",
      userId: "host",
      role: "host",
    });
    await db
      .update(meetingAdmissions)
      .set({ admissionStatus: "revoked" })
      .where(eq(meetingAdmissions.id, "admission_host_conn"));

    await expect(
      canActiveParticipantReadWhiteboardAsset(db, {
        meetingId: "meeting_1",
        connectionId: "host_conn",
        participantIdentity: "host_identity",
      }),
    ).resolves.toBe(false);
  });

  it("binds an edit grant to the Meeting's own boards", async () => {
    await insertUser("host");
    await insertUser("editor");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "editor_conn",
      meetingId: "meeting_1",
      userId: "editor",
      role: "attendee",
    });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "board_b",
      meetingId: "meeting_1",
      spaceId: "host_space",
      title: "Board B",
      now: new Date(),
    });
    // The coordinator's grant, as it projects it onto the admission.
    await db.update(meetingAdmissions)
      .set({ whiteboardEditGranted: true })
      .where(eq(meetingAdmissions.id, "admission_editor_conn"));

    await expect(
      getActiveWhiteboardParticipantAccess(db, "meeting_1", "editor_conn"),
    ).resolves.toMatchObject({ whiteboardEditGranted: true, canEditWhiteboard: true });
    // Addressing board B's room honors the Meeting's grant.
    await expect(
      getActiveWhiteboardParticipantAccess(db, "meeting_1", "editor_conn", "board_b"),
    ).resolves.toMatchObject({ whiteboardEditGranted: true, canEditWhiteboard: true });
    // A room the Meeting does not present cannot borrow it.
    await expect(
      getActiveWhiteboardParticipantAccess(db, "meeting_1", "editor_conn", "another_room"),
    ).resolves.toBeNull();
  });

  // The incident: a host granted a guest edit access, the room revoked the
  // guest's socket to pick up an editing token, and the token the rejoin
  // handed out still said read-only. Every mint path must derive the grant
  // exactly as the room's authority check does, or the verdict is "refresh"
  // forever.
  it("mints a granted guest's capabilities the way the authority check reads them", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "guest_conn",
      meetingId: "meeting_1",
      userId: null,
      role: "attendee",
    });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "board_a",
      meetingId: "meeting_1",
      spaceId: "host_space",
      title: "Board A",
      now: new Date(),
    });
    await db.update(meetingAdmissions)
      .set({ whiteboardEditGranted: true })
      .where(eq(meetingAdmissions.id, "admission_guest_conn"));

    const minted = await resolveWhiteboardCapabilities(db, {
      meetingId: "meeting_1",
      principal: { type: "guest_admission", id: "admission_guest_conn" },
      base: whiteboardCapabilitiesForMeetingRole("attendee"),
    });
    const [lookup] = await lookupWhiteboardSocketAccesses(db, "board_a", [
      { connectionId: "guest_conn", documentId: "board_a" },
    ]);

    expect(minted.capabilities.canEditWhiteboard).toBe(true);
    expect(lookup).toMatchObject({ status: "seated", documentChanged: false });
    if (lookup?.status !== "seated") throw new Error("expected a seated lookup");
    expect(
      areWhiteboardCapabilitiesStillAllowed(minted.capabilities, lookup.access.capabilities),
    ).toBe(true);
    // A role-only token — what the join used to hand out — is what the room
    // kept refusing.
    expect(
      areWhiteboardCapabilitiesStillAllowed(
        whiteboardCapabilitiesForMeetingRole("attendee"),
        lookup.access.capabilities,
      ),
    ).toBe(false);
  });

  it("requires socket capabilities to match current authority exactly", () => {
    expect(
      areWhiteboardCapabilitiesStillAllowed(
        { canEditWhiteboard: false, canControlSurface: false, canManageWhiteboard: false },
        { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
      ),
    ).toBe(false);

    expect(
      areWhiteboardCapabilitiesStillAllowed(
        { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
        { canEditWhiteboard: false, canControlSurface: false, canManageWhiteboard: false },
      ),
    ).toBe(false);
  });

  it("does not allow a token to claim management without current management authority", () => {
    expect(
      areWhiteboardCapabilitiesStillAllowed(
        { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
        { canEditWhiteboard: true, canControlSurface: false, canManageWhiteboard: false },
      ),
    ).toBe(false);
  });

  it("grants authenticated meeting moderators full whiteboard authority", async () => {
    await insertUser("host");
    await insertUser("member");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "member_conn",
      meetingId: "meeting_1",
      userId: "member",
      role: "moderator",
      meetingModerator: true,
    });

    const access = await getActiveWhiteboardParticipantAccess(db, "meeting_1", "member_conn");

    expect(access).toMatchObject({
      role: "participant",
      capabilities: {
        canEditWhiteboard: true,
        canControlSurface: true,
        canManageWhiteboard: true,
      },
    });
  });

  it("grants guest meeting moderators full whiteboard authority", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "guest_conn",
      meetingId: "meeting_1",
      userId: null,
      role: "moderator",
      meetingModerator: true,
    });

    const access = await getActiveWhiteboardParticipantAccess(db, "meeting_1", "guest_conn");

    expect(access).toMatchObject({
      participantIdentity: "guest_guest_conn",
      userId: null,
      role: "guest",
      capabilities: {
        canEditWhiteboard: true,
        canControlSurface: true,
        canManageWhiteboard: true,
      },
    });
  });

  it("takes whiteboard capabilities from the role the meeting's room projected", async () => {
    const now = new Date();
    await insertUser("owner");
    await insertUser("admin");
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_1",
      slug: "space_1-slug",
      name: "Product",
      description: null,
      ownerUserId: "owner",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values([
      { id: "space_owner", spaceId: "space_1", userId: "owner", role: "admin", joinedAt: now },
      { id: "space_admin", spaceId: "space_1", userId: "admin", role: "admin", joinedAt: now },
    ]);
    // A link never moves spaces, so create the shared-space link and its
    // meeting directly.
    await db.insert(meetingLinks).values({
      id: "link_meeting_space",
      code: "abc-defg-hij",
      reusePolicy: "reusable",
      spaceId: "space_1",
spaceKind: "shared" as const,
      title: "Meeting",
      allowGuests: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "meeting_space",
      meetingLinkId: "link_meeting_space",
      startedByUserId: "owner",
      spaceId: "space_1",
      spaceKind: "shared" as const,
      billingPrincipalType: "user" as const,
      billingPrincipalId: "owner",
      billingPlan: "free",
      title: "Meeting",
      status: "open",
      allowGuests: false,
      recordingEnabled: false,
      startedAt: now,
      updatedAt: now,
    });
    await insertConnection({
      id: "admin_conn",
      meetingId: "meeting_space",
      userId: "admin",
      role: "host",
    });
    const projectRole = (role: "host" | "attendee") =>
      db.update(meetingConnections).set({ role }).where(eq(meetingConnections.id, "admin_conn"));

    await expect(getActiveWhiteboardParticipantAccess(db, "meeting_space", "admin_conn")).resolves.toMatchObject({
      role: "participant",
      capabilities: { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
    });

    // A Space demotion reaches the board when the room applies it and
    // projects the new role (runtime/step.ts, `authority`), never before: the
    // board and the meeting's own media grants change together.
    await db.update(spaceMembers).set({ role: "member" }).where(eq(spaceMembers.id, "space_admin"));
    await expect(getActiveWhiteboardParticipantAccess(db, "meeting_space", "admin_conn")).resolves.toMatchObject({
      capabilities: { canManageWhiteboard: true },
    });
    await projectRole("attendee");
    await expect(getActiveWhiteboardParticipantAccess(db, "meeting_space", "admin_conn")).resolves.toMatchObject({
      role: "participant",
      capabilities: { canEditWhiteboard: false, canControlSurface: false, canManageWhiteboard: false },
    });
  });

  // The sync server distinguishes "denied" (4xx/{active:false}) from
  // "unavailable" (5xx, bounded stale-allow). An ended or deleted meeting is a
  // definitive denial, so these lookups must resolve null — a throw would
  // surface as a 500 and keep ended-meeting sockets alive on stale-allow.
  it("resolves null instead of throwing for an ended meeting", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "host_conn",
      meetingId: "meeting_1",
      userId: "host",
      role: "host",
    });
    await endMeeting("meeting_1");

    await expect(
      getActiveWhiteboardParticipantAccess(db, "meeting_1", "host_conn"),
    ).resolves.toBeNull();
  });

  it("resolves null instead of throwing for a deleted meeting", async () => {
    await expect(
      getActiveWhiteboardParticipantAccess(db, "missing_meeting", "some_conn"),
    ).resolves.toBeNull();
  });

  // Socket revalidation has to tell these two apart: one is recoverable by
  // minting a fresh token, the other never is. See
  // classifyWhiteboardAccessValidation.
  it("reports a superseded connection lease as retired, not unauthorized", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await insertConnection({
      id: "host_conn",
      meetingId: "meeting_1",
      userId: "host",
      role: "host",
    });

    await expect(
      lookupWhiteboardParticipantAccess(db, "meeting_1", "host_conn"),
    ).resolves.toMatchObject({ status: "seated" });

    // What a LiveKit reconnect leaves behind: the old lease ends, a new one is
    // issued, and the whiteboard socket still carries the retired id.
    await db
      .update(meetingConnections)
      .set({ connectionStatus: "ended", disconnectedAt: new Date() })
      .where(eq(meetingConnections.id, "host_conn"));

    await expect(
      lookupWhiteboardParticipantAccess(db, "meeting_1", "host_conn"),
    ).resolves.toEqual({ status: "retired" });

    await endMeeting("meeting_1");

    await expect(
      lookupWhiteboardParticipantAccess(db, "meeting_1", "host_conn"),
    ).resolves.toEqual({ status: "unauthorized" });
  });

  it("denies recorder access once the meeting has ended", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host");
    await db
      .update(meetings)
      .set({ activeEgressId: "egress_1" })
      .where(eq(meetings.id, "meeting_1"));

    await expect(canAccessWhiteboardAsRecorder(db, "meeting_1")).resolves.toBe(true);

    await endMeeting("meeting_1");

    await expect(canAccessWhiteboardAsRecorder(db, "meeting_1")).resolves.toBe(false);
  });
});

import { seedPersonalSpace } from "@/test/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./db";
import { boundedStatements } from "@/platform/database/db-batching";
import { generateId } from "@/lib/ids";
import {
  meetingAdmissions,
  meetingArtifacts,
  meetingConnections,
  meetingLinks,
  meetings,
  meetingWhiteboards,
  organizationMembers,
  organizations,
  passkeys,
  sessions,
  spaceDefaultMeetingLinks,
  spaces,
  transcripts,
  users,
  verifications,
  whiteboardRevisions,
  whiteboards,
} from "@orbmeet/db/schema";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertUser(id = "usr_schema") {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: "Schema User",
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, id, { now });
}

async function insertMeetingFixture(input: {
  meetingId: string;
  linkId: string;
  code: string;
  ownerUserId: string;
  spaceId?: string;
  status?: "open" | "ended";
}) {
  const now = new Date();
  const status = input.status ?? "open";
  const spaceId = input.spaceId ?? `${input.ownerUserId}_space`;
  const spaceKind = input.spaceId ? ("shared" as const) : ("personal" as const);

  await db.insert(meetingLinks).values({
    id: input.linkId,
    code: input.code,
    spaceId,
    spaceKind,
    title: "Schema Meeting",
    allowGuests: spaceKind === "personal",
    joinPolicy: "open",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(meetings).values({
    id: input.meetingId,
    meetingLinkId: input.linkId,
    title: "Schema Meeting",
    startedByUserId: input.ownerUserId,
    spaceId,
    spaceKind,
    status,
    billingPrincipalType: "user" as const,
    billingPrincipalId: input.ownerUserId,
    billingPlan: "free",
    // Guest entry is a personal-space capability.
    allowGuests: spaceKind === "personal",
    recordingEnabled: false,
    joinPolicy: "open",
    activeEgressId: null,
    startedAt: now,
    endedAt: status === "ended" ? now : null,
    retainUntil: null,
    updatedAt: now,
  });
}

async function insertApprovedAdmission(input: {
  id: string;
  meetingId: string;
  userId: string;
  role?: "host" | "moderator" | "attendee";
}) {
  const now = new Date();
  const role = input.role ?? "attendee";

  await db.insert(meetingAdmissions).values({
    id: input.id,
    meetingId: input.meetingId,
    subjectType: "user",
    subjectUserId: input.userId,
    displayName: "Schema User",
    meetingModerator: role === "moderator",
    admissionStatus: "approved",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

describe("database schema integrity", () => {
  it("permits only one occurrence for a one-time meeting link", async () => {
    await insertUser("usr_one_time_link");
    const now = new Date();
    const spaceId = "usr_one_time_link_space";
    await db.insert(meetingLinks).values({
      id: "link_one_time_schema",
      code: "one-time-dbq",
      reusePolicy: "one_time",
      spaceId,
      spaceKind: "personal",
      allowGuests: true,
      createdAt: now,
      updatedAt: now,
    });
    const occurrence = (id: string) => ({
      id,
      meetingLinkId: "link_one_time_schema",
      startedByUserId: "usr_one_time_link",
      spaceId,
      spaceKind: "personal" as const,
      status: "ended" as const,
      billingPrincipalType: "user" as const,
      billingPrincipalId: "usr_one_time_link",
      billingPlan: "free" as const,
      allowGuests: true,
      startedAt: now,
      endedAt: now,
      updatedAt: now,
    });

    await db.insert(meetings).values(occurrence("meeting_one_time_first"));
    await db.update(meetingLinks)
      .set({ spentAt: now, updatedAt: now })
      .where(eq(meetingLinks.id, "link_one_time_schema"));

    await expect(db.insert(meetings).values(occurrence("meeting_one_time_second")))
      .rejects.toBeDefined();
  });

  it("enforces the raw 200-character Whiteboard title limit on insert and update", async () => {
    await insertUser();
    const now = new Date();
    const oversizedRawTitle = `${"x".repeat(200)} `;

    await expect(db.insert(whiteboards).values({
      id: "whiteboard_oversized_insert",
      syncRoomId: "whiteboard_oversized_insert",
      spaceId: "usr_schema_space",
      title: oversizedRawTitle,
      createdAt: now,
      updatedAt: now,
    })).rejects.toBeDefined();

    await db.insert(whiteboards).values({
      id: "whiteboard_oversized_update",
      syncRoomId: "whiteboard_oversized_update",
      spaceId: "usr_schema_space",
      title: "Valid title",
      createdAt: now,
      updatedAt: now,
    });
    await expect(db.update(whiteboards)
      .set({ title: oversizedRawTitle })
      .where(eq(whiteboards.id, "whiteboard_oversized_update")))
      .rejects.toBeDefined();
  });

  it("rejects an archived Whiteboard without an archive timestamp", async () => {
    await insertUser();
    const now = new Date();
    await insertMeetingFixture({
      meetingId: "mtg_invalid_board",
      linkId: "link_invalid_board",
      code: "inv-brda-aaa",
      ownerUserId: "usr_schema",
    });

    await expect(db.insert(whiteboards).values({
      id: "whiteboard_invalid_shape",
      syncRoomId: "whiteboard_invalid_shape",
      spaceId: "usr_schema_space",
      title: "Invalid archived board",
      status: "archived",
      createdAt: now,
      updatedAt: now,
    })).rejects.toBeDefined();
  });

  it("allows multiple Whiteboards per Meeting but only one use of each document", async () => {
    await insertUser();
    const now = new Date();
    await insertMeetingFixture({
      meetingId: "mtg_board_one",
      linkId: "room_board_one",
      code: "brd-onea-aaa",
      ownerUserId: "usr_schema",
    });
    await db.insert(whiteboards).values({
      id: "whiteboard_first",
      syncRoomId: "whiteboard_first",
      spaceId: "usr_schema_space",
      title: "First board",
      createdByUserId: "usr_schema",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(whiteboards).values({
      id: "whiteboard_second",
      syncRoomId: "whiteboard_second",
      spaceId: "usr_schema_space",
      title: "Second board",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetingWhiteboards).values([
      {
        id: "meeting_whiteboard_first",
        meetingId: "mtg_board_one",
        spaceId: "usr_schema_space",
        whiteboardId: "whiteboard_first",
        attachedAt: now,
      },
      {
        id: "meeting_whiteboard_second",
        meetingId: "mtg_board_one",
        spaceId: "usr_schema_space",
        whiteboardId: "whiteboard_second",
        attachedAt: now,
      },
    ]);
    await expect(db.insert(meetingWhiteboards).values({
      id: "meeting_whiteboard_duplicate",
      meetingId: "mtg_board_one",
      spaceId: "usr_schema_space",
      whiteboardId: "whiteboard_first",
      attachedAt: now,
    })).rejects.toBeDefined();
  });

  it("requires a Meeting and every presented Whiteboard to share one Space", async () => {
    await insertUser();
    await insertUser("usr_other");
    const now = new Date();
    await insertMeetingFixture({
      meetingId: "mtg_cross_space",
      linkId: "room_cross_space",
      code: "xsp-brda-aaa",
      ownerUserId: "usr_schema",
    });
    await db.insert(whiteboards).values({
      id: "whiteboard_cross_space",
      syncRoomId: "whiteboard_cross_space",
      spaceId: "usr_other_space",
      title: "Personal Whiteboard in a Space Meeting",
      createdAt: now,
      updatedAt: now,
    });
    await expect(db.insert(meetingWhiteboards).values({
      id: "meeting_whiteboard_cross_space",
      meetingId: "mtg_cross_space",
      spaceId: "usr_schema_space",
      whiteboardId: "whiteboard_cross_space",
      attachedAt: now,
    })).rejects.toBeDefined();
  });

  it("requires pinned Meeting revisions to belong to the presented Whiteboard", async () => {
    await insertUser();
    const now = new Date();
    await insertMeetingFixture({
      meetingId: "mtg_revision_pin",
      linkId: "room_revision_pin",
      code: "rev-pina-aaa",
      ownerUserId: "usr_schema",
    });
    await db.insert(whiteboards).values([
      {
        id: "whiteboard_pin_target",
        syncRoomId: "whiteboard_pin_target",
        spaceId: "usr_schema_space",
        title: "Target board",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "whiteboard_pin_other",
        syncRoomId: "whiteboard_pin_other",
        spaceId: "usr_schema_space",
        title: "Other board",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(whiteboardRevisions).values([
      {
        id: "revision_pin_target",
        whiteboardId: "whiteboard_pin_target",
        spaceId: "usr_schema_space",
        revisionNumber: 1,
        kind: "checkpoint",
        snapshotR2Key: "whiteboards/whiteboard_pin_target/revisions/1.bin",
        snapshotSize: 1,
        createdAt: now,
      },
      {
        id: "revision_pin_other",
        whiteboardId: "whiteboard_pin_other",
        spaceId: "usr_schema_space",
        revisionNumber: 1,
        kind: "checkpoint",
        snapshotR2Key: "whiteboards/whiteboard_pin_other/revisions/1.bin",
        snapshotSize: 1,
        createdAt: now,
      },
    ]);

    await expect(db.insert(meetingWhiteboards).values({
      id: "meeting_whiteboard_bad_start_pin",
      meetingId: "mtg_revision_pin",
      spaceId: "usr_schema_space",
      whiteboardId: "whiteboard_pin_target",
      startRevisionId: "revision_pin_other",
      attachedAt: now,
    })).rejects.toBeDefined();
    await expect(db.insert(meetingWhiteboards).values({
      id: "meeting_whiteboard_bad_capture_pin",
      meetingId: "mtg_revision_pin",
      spaceId: "usr_schema_space",
      whiteboardId: "whiteboard_pin_target",
      capturedRevisionId: "revision_pin_other",
      captureStatus: "captured",
      capturedAt: now,
      attachedAt: now,
    })).rejects.toBeDefined();

    await db.insert(meetingWhiteboards).values({
      id: "meeting_whiteboard_valid_pin",
      meetingId: "mtg_revision_pin",
      spaceId: "usr_schema_space",
      whiteboardId: "whiteboard_pin_target",
      startRevisionId: "revision_pin_target",
      attachedAt: now,
    });
    await expect(db.update(meetingWhiteboards)
      .set({ startRevisionId: "revision_pin_other" })
      .where(eq(meetingWhiteboards.id, "meeting_whiteboard_valid_pin")))
      .rejects.toBeDefined();
    await expect(db.update(meetingWhiteboards)
      .set({
        capturedRevisionId: "revision_pin_other",
        captureStatus: "captured",
        capturedAt: now,
      })
      .where(eq(meetingWhiteboards.id, "meeting_whiteboard_valid_pin")))
      .rejects.toBeDefined();
  });

  it("refuses to erase a Space that still owns Meeting history", async () => {
    await insertUser();
    const now = new Date();
    await insertMeetingFixture({
      meetingId: "mtg_erased_board",
      linkId: "room_erased_board",
      code: "era-brda-aaa",
      ownerUserId: "usr_schema",
    });
    await db.insert(whiteboards).values({
      id: "whiteboard_erased",
      syncRoomId: "whiteboard_erased",
      spaceId: "usr_schema_space",
      title: "Erased board",
      createdAt: now,
      updatedAt: now,
    });

    // Deletion is cascade-down/restrict-up: a Space cannot be erased out from
    // under its Meetings, so callers must purge Meeting history first.
    await expect(db.delete(spaces).where(eq(spaces.id, "usr_schema_space")))
      .rejects.toBeDefined();

    await db.delete(whiteboards).where(eq(whiteboards.id, "whiteboard_erased"));
    await db.delete(meetings).where(eq(meetings.id, "mtg_erased_board"));
    await db.delete(meetingLinks).where(eq(meetingLinks.id, "room_erased_board"));
    await expect(db.delete(spaces).where(eq(spaces.id, "usr_schema_space")))
      .resolves.toBeDefined();
  });

  it("rejects present previous session token hashes that are not SHA-256 length", async () => {
    await insertUser();
    const now = new Date();

    await expect(
      db.insert(sessions).values({
        id: "ses_short_previous_hash",
        tokenHash: "a".repeat(64),
        previousTokenHash: "short",
        userId: "usr_schema",
        expiresAt: new Date(now.getTime() + 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 120_000),
        ipAddress: null,
        userAgent: null,
        createdAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("rejects required text values padded past their storage limit", async () => {
    const now = new Date();

    await expect(
      db.insert(users).values({
        id: "usr_padded_name",
        name: `A${" ".repeat(100)}`,
        email: "padded@example.com",
        normalizedEmail: "padded@example.com",
        image: null,
        plan: "free",
        role: "user",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("cascades deleted users out of admission rows instead of violating admission shape checks", async () => {
    await insertUser("usr_host");
    await insertUser("usr_member");
    const now = new Date();

    await db.insert(meetingLinks).values({
      id: "room_user_delete",
      code: "def-ghij-klm",
      spaceId: "usr_host_space",
spaceKind: "personal" as const,
      title: "User Delete Meeting",
      allowGuests: true,
      joinPolicy: "open",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(meetings).values({
      id: "mtg_user_delete",
      meetingLinkId: "room_user_delete",
      title: "User Delete Meeting",
      startedByUserId: "usr_host",
      spaceId: "usr_host_space",
      spaceKind: "personal" as const,
      status: "ended",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "usr_host",
      billingPlan: "free",
      allowGuests: true,
      recordingEnabled: false,
      joinPolicy: "open",
      activeEgressId: null,
      startedAt: now,
      endedAt: now,
      retainUntil: new Date(now.getTime() + 60_000),
      updatedAt: now,
    });

    await db.insert(meetingAdmissions).values({
      id: "mad_deleted_user",
      meetingId: "mtg_user_delete",
      subjectType: "user",
      subjectUserId: "usr_member",
      displayName: "Member",
      guestSecretHash: null,
      admissionStatus: "approved",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Account deletion removes the personal space (ownerUserId is RESTRICT)
    // before the user row, so mirror that order here.
    await db.delete(spaces).where(eq(spaces.id, "usr_member_space"));
    await expect(db.delete(users).where(eq(users.id, "usr_member"))).resolves.toBeDefined();

    const remaining = await db.query.meetingAdmissions.findFirst({
      where: { id: "mad_deleted_user" },
    });
    expect(remaining).toBeUndefined();
  });

  it("requires every link to belong to a space and keeps Space defaults permanent", async () => {
    await insertUser("usr_space_owner");
    const now = new Date();
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_link_owner_shape",
      name: "Owned by Space",
      ownerUserId: "usr_space_owner",
      slug: "owned-by-space",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(meetingLinks).values({
        id: "link_without_space",
        code: "own-shap-nul",
        spaceId: null as unknown as string,
spaceKind: "personal" as const,
        allowGuests: true,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
    await expect(
      db.insert(meetingLinks).values({
        id: "link_with_legacy_default_kind",
        code: "own-shap-old",
        reusePolicy: "default" as "reusable",
        spaceId: "space_link_owner_shape",
spaceKind: "shared" as const,
        allowGuests: false,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
    await db.insert(meetingLinks).values({
      id: "link_default_with_expiry",
      code: "own-shap-bad",
      reusePolicy: "reusable",
      spaceId: "space_link_owner_shape",
spaceKind: "shared" as const,
      allowGuests: false,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    });
    await expect(db.insert(spaceDefaultMeetingLinks).values({
      spaceId: "space_link_owner_shape",
      spaceKind: "shared",
      meetingLinkId: "link_default_with_expiry",
      linkReusePolicy: "reusable",
    })).rejects.toBeDefined();
  });

  it("rejects sessions whose sliding expiry exceeds the absolute expiry", async () => {
    await insertUser();
    const now = new Date();

    await expect(
      db.insert(sessions).values({
        id: "ses_invalid",
        tokenHash: "token-hash",
        previousTokenHash: null,
        userId: "usr_schema",
        expiresAt: new Date(now.getTime() + 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 30_000),
        ipAddress: null,
        userAgent: null,
        createdAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("rejects ended meetings whose endedAt is before startedAt", async () => {
    await insertUser();
    const now = new Date();
    await db.insert(meetingLinks).values({
      id: "room_invalid_session",
      code: "abc-defg-hij",
      spaceId: "usr_schema_space",
spaceKind: "personal" as const,
      title: "Broken Meeting",
      allowGuests: true,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(meetings).values({
        id: "mtg_invalid",
        meetingLinkId: "room_invalid_session",
        title: "Broken Meeting",
        startedByUserId: "usr_schema",
        spaceId: "usr_schema_space",
        spaceKind: "personal" as const,
        status: "ended",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "usr_schema",
      billingPlan: "free",
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        activeEgressId: null,
        startedAt: now,
        endedAt: new Date(now.getTime() - 1_000),
        retainUntil: new Date(now.getTime() + 60_000),
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("rejects reusable link codes that do not match the canonical meeting code format", async () => {
    await insertUser();
    const now = new Date();

    await expect(
      db.insert(meetingLinks).values({
        id: "lnk_invalid",
        code: "room-1",
        spaceId: "usr_schema_space",
spaceKind: "personal" as const,
        title: "Broken Link",
        allowGuests: true,
        joinPolicy: "open",
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("rejects LiveKit connection rows whose disconnectedAt precedes tokenIssuedAt", async () => {
    await insertUser();
    const now = new Date();
    await db.insert(meetingLinks).values({
      id: "room_valid",
      code: "jkl-mnop-qrs",
      spaceId: "usr_schema_space",
spaceKind: "personal" as const,
      title: "Valid Meeting",
      allowGuests: true,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(meetings).values({
      id: "mtg_valid",
      meetingLinkId: "room_valid",
      title: "Valid Meeting",
      startedByUserId: "usr_schema",
      spaceId: "usr_schema_space",
      spaceKind: "personal" as const,
      status: "open",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "usr_schema",
      billingPlan: "free",
      allowGuests: true,
      recordingEnabled: false,
      joinPolicy: "open",
      activeEgressId: null,
      startedAt: now,
      endedAt: null,
      retainUntil: null,
      updatedAt: now,
    });

    await db.insert(meetingAdmissions).values({
      id: "mad_valid",
      meetingId: "mtg_valid",
      subjectType: "user",
      subjectUserId: "usr_schema",
      displayName: "Schema User",
      admissionStatus: "approved",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(meetingConnections).values({
        id: "mlp_invalid",
        meetingId: "mtg_valid",
        admissionId: "mad_valid",
        livekitIdentity: "usr_schema_mlp_invalid",
        userId: "usr_schema",
        role: "attendee",
        connectionStatus: "ended",
        tokenIssuedAt: now,
        disconnectedAt: new Date(now.getTime() - 1_000),
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("rejects oversized transcript segments", async () => {
    await insertUser();
    const now = new Date();
    await db.insert(meetingLinks).values({
      id: "room_transcript_limit",
      code: "lmn-opqr-stu",
      spaceId: "usr_schema_space",
spaceKind: "personal" as const,
      title: "Transcript Limit",
      allowGuests: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "mtg_transcript_limit",
      meetingLinkId: "room_transcript_limit",
      title: "Transcript Limit",
      startedByUserId: "usr_schema",
      spaceId: "usr_schema_space",
      spaceKind: "personal" as const,
      status: "ended",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "usr_schema",
      billingPlan: "free",
      allowGuests: true,
      recordingEnabled: false,
      joinPolicy: "open",
      activeEgressId: null,
      startedAt: now,
      endedAt: now,
      retainUntil: new Date(now.getTime() + 60_000),
      updatedAt: now,
    });

    await expect(
      db.insert(transcripts).values({
        id: "trn_oversized_text",
        meetingId: "mtg_transcript_limit",
        admissionId: null,
        connectionId: null,
        participantIdentity: "usr_schema",
        participantName: "Schema User",
        text: "a".repeat(32_769),
        segmentId: "segment-1",
        language: "en",
        speakerId: null,
        startedAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("requires credentials for usable guest admissions but allows revoked guests without stored credentials", async () => {
    await insertUser();
    const now = new Date();
    await db.insert(meetingLinks).values({
      id: "room_guest_shape",
      code: "stu-vwxy-zab",
      spaceId: "usr_schema_space",
spaceKind: "personal" as const,
      title: "Guest Shape",
      allowGuests: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "mtg_guest_shape",
      meetingLinkId: "room_guest_shape",
      title: "Guest Shape",
      startedByUserId: "usr_schema",
      spaceId: "usr_schema_space",
      spaceKind: "personal" as const,
      status: "ended",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "usr_schema",
      billingPlan: "free",
      allowGuests: true,
      recordingEnabled: false,
      joinPolicy: "open",
      activeEgressId: null,
      startedAt: now,
      endedAt: now,
      retainUntil: new Date(now.getTime() + 60_000),
      updatedAt: now,
    });

    await expect(
      db.insert(meetingAdmissions).values({
        id: "mad_guest_missing_secret",
        meetingId: "mtg_guest_shape",
        subjectType: "guest",
        subjectUserId: null,
        guestSecretHash: null,
        displayName: "Guest",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();

    await expect(
      db.insert(meetingAdmissions).values({
        id: "mad_guest_revoked_no_secret",
        meetingId: "mtg_guest_shape",
        subjectType: "guest",
        subjectUserId: null,
        guestSecretHash: null,
        displayName: "Guest",
        admissionStatus: "revoked",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects malformed verification JSON payloads", async () => {
    await expect(
      db.insert(verifications).values({
        id: crypto.randomUUID(),
        type: "otp_signup",
        identifier: "signup:schema@example.com",
        value: "hash",
        data: "not-json",
        expiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      }),
    ).rejects.toBeDefined();
  });

  it("rejects malformed passkey transports payloads", async () => {
    await insertUser();
    const now = new Date();

    await expect(
      db.insert(passkeys).values({
        id: "psk_invalid",
        userId: "usr_schema",
        credentialId: "credential-id",
        publicKey: "public-key",
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        transports: "not-json" as unknown as string[],
        name: "Laptop",
        createdAt: now,
        lastUsedAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("enforces foreign keys in the local test database like D1", async () => {
    const now = new Date();

    await expect(
      db.insert(sessions).values({
        id: "ses_missing_user",
        tokenHash: "a".repeat(64),
        previousTokenHash: null,
        userId: "usr_missing",
        expiresAt: new Date(now.getTime() + 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 120_000),
        ipAddress: null,
        userAgent: null,
        createdAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("uses member as the baseline organization role", async () => {
    await insertUser("usr_org_owner");
    await insertUser("usr_org_member");
    const now = new Date();

    await db.insert(organizations).values({
      id: "org_schema",
      name: "Schema Org",
      ownerId: "usr_org_owner",
      plan: "organization",
      licenseLimit: 25,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(organizationMembers).values({
        id: "omb_schema_member",
        organizationId: "org_schema",
        userId: "usr_org_member",
        role: "member",
        joinedAt: now,
      }),
    ).resolves.toBeDefined();

    await expect(
      db.insert(organizationMembers).values({
        id: "omb_schema_invalid_role",
        organizationId: "org_schema",
        userId: "usr_org_owner",
        role: "viewer" as (typeof organizationMembers.$inferInsert)["role"],
        joinedAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("keeps connection admissions scoped to the same meeting", async () => {
    await insertUser("usr_cross_meeting");
    const now = new Date();

    await insertMeetingFixture({
      meetingId: "mtg_scope_one",
      linkId: "room_scope_one",
      code: "bcd-efgh-ijk",
      ownerUserId: "usr_cross_meeting",
      status: "ended",
    });
    await insertMeetingFixture({
      meetingId: "mtg_scope_two",
      linkId: "room_scope_two",
      code: "cde-fghi-jkl",
      ownerUserId: "usr_cross_meeting",
    });
    await insertApprovedAdmission({
      id: "mad_scope_one",
      meetingId: "mtg_scope_one",
      userId: "usr_cross_meeting",
    });

    await expect(
      db.insert(meetingConnections).values({
        id: "conn_wrong_meeting",
        meetingId: "mtg_scope_two",
        admissionId: "mad_scope_one",
        livekitIdentity: "usr_cross_meeting_wrong",
        userId: "usr_cross_meeting",
        role: "attendee",
        connectionStatus: "pending",
        tokenIssuedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("keeps transcript admissions and connections scoped to the same meeting", async () => {
    await insertUser("usr_transcript_scope");
    const now = new Date();

    await insertMeetingFixture({
      meetingId: "mtg_transcript_one",
      linkId: "room_transcript_one",
      code: "efg-hijk-lmn",
      ownerUserId: "usr_transcript_scope",
      status: "ended",
    });
    await insertMeetingFixture({
      meetingId: "mtg_transcript_two",
      linkId: "room_transcript_two",
      code: "fgh-ijkl-mno",
      ownerUserId: "usr_transcript_scope",
    });
    await insertApprovedAdmission({
      id: "mad_transcript_one",
      meetingId: "mtg_transcript_one",
      userId: "usr_transcript_scope",
    });
    await db.insert(meetingConnections).values({
      id: "conn_transcript_one",
      meetingId: "mtg_transcript_one",
      admissionId: "mad_transcript_one",
      livekitIdentity: "usr_transcript_scope",
      userId: "usr_transcript_scope",
      role: "attendee",
      connectionStatus: "live",
      tokenIssuedAt: now,
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(transcripts).values({
        id: "trn_wrong_meeting_refs",
        meetingId: "mtg_transcript_two",
        admissionId: "mad_transcript_one",
        connectionId: "conn_transcript_one",
        participantIdentity: "usr_transcript_scope",
        participantName: "Schema User",
        text: "hello",
        segmentId: "segment-wrong-meeting",
        startedAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("rejects terminal admissions that retain a moderator grant", async () => {
    await insertUser("usr_terminal_grant");
    const now = new Date();

    await insertMeetingFixture({
      meetingId: "mtg_terminal_grant",
      linkId: "room_terminal_grant",
      code: "ghi-jklm-nop",
      ownerUserId: "usr_terminal_grant",
    });

    await expect(
      db.insert(meetingAdmissions).values({
        id: "mad_terminal_grant",
        meetingId: "mtg_terminal_grant",
        subjectType: "user",
        subjectUserId: "usr_terminal_grant",
        displayName: "Schema User",
        admissionStatus: "revoked",
        meetingModerator: true,
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("requires meeting artifact space to match its meeting", async () => {
    await insertUser("usr_artifact_scope");
    const now = new Date();

    await db.insert(spaces).values({
      kind: "shared",
      id: "space_artifact_one",
      slug: "space_artifact_one-slug",
      name: "Artifact One",
      ownerUserId: "usr_artifact_scope",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_artifact_two",
      slug: "space_artifact_two-slug",
      name: "Artifact Two",
      ownerUserId: "usr_artifact_scope",
      createdAt: now,
      updatedAt: now,
    });
    await insertMeetingFixture({
      meetingId: "mtg_artifact_scope",
      linkId: "room_artifact_scope",
      code: "hij-klmn-opq",
      ownerUserId: "usr_artifact_scope",
      spaceId: "space_artifact_one",
    });

    await expect(
      db.insert(meetingArtifacts).values({
        id: "artifact_wrong_space",
        meetingId: "mtg_artifact_scope",
        spaceId: "space_artifact_two",
        type: "whiteboard_pdf",
        r2Key: "meetings/mtg_artifact_scope/exports/whiteboard.pdf",
        filename: "wrong-space.pdf",
        mimeType: "application/pdf",
        size: 1,
        uploadedByUserId: "usr_artifact_scope",
        createdAt: now,
      }),
    ).rejects.toBeDefined();
  });

  it("allows only one organization ownership row per billing owner", async () => {
    await insertUser("usr_single_org_owner");
    const now = new Date();

    await db.insert(organizations).values({
      id: "org_single_owner_one",
      name: "Owner Org One",
      ownerId: "usr_single_org_owner",
      plan: "organization",
      licenseLimit: 25,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(organizations).values({
        id: "org_single_owner_two",
        name: "Owner Org Two",
        ownerId: "usr_single_org_owner",
        plan: "organization",
        licenseLimit: 25,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeDefined();
  });
});

let NOW = new Date(Math.floor(Date.now() / 1000) * 1000);

describe("composite foreign keys and projection triggers", () => {
  beforeEach(async () => {
    NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
    // Insert base user and spaces
    await db.insert(users).values({
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
      normalizedEmail: "alice@example.com",
      plan: "free",
      role: "user",
      createdAt: NOW,
      updatedAt: NOW,
    });

    await db.insert(spaces).values({
      id: "space-personal-1",
      ownerUserId: "user-1",
      kind: "personal",
      name: "Alice's Space",
      createdAt: NOW,
      updatedAt: NOW,
    });

    await db.insert(spaces).values({
      id: "space-shared-1",
      ownerUserId: "user-1",
      kind: "shared",
      name: "Engineering Space",
      slug: "eng-space-1",
      createdAt: NOW,
      updatedAt: NOW,
    });

    await db.insert(spaces).values({
      id: "space-shared-2",
      ownerUserId: "user-1",
      kind: "shared",
      name: "Product Space",
      slug: "prod-space-2",
      createdAt: NOW,
      updatedAt: NOW,
    });

    // Create standard links for personal and shared spaces
    await db.insert(meetingLinks).values({
      id: "link-personal-std",
      code: "per-link-one",
      spaceId: "space-personal-1",
      spaceKind: "personal",
      allowGuests: true,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await db.insert(meetingLinks).values({
      id: "link-shared-std",
      code: "sha-link-one",
      spaceId: "space-shared-1",
      spaceKind: "shared",
      allowGuests: false,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await db.insert(meetingLinks).values({
      id: "link-shared-2",
      code: "sha-link-two",
      spaceId: "space-shared-2",
      spaceKind: "shared",
      allowGuests: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  async function insertMeeting(input: {
    id: string;
    spaceId: string;
    spaceKind: "shared" | "personal";
    meetingLinkId: string;
    startedByUserId?: string;
    billingPrincipalType?: "user" | "organization";
    billingPrincipalId?: string;
    billingPlan?: "free" | "pro" | "team" | "organization";
    status?: "open" | "ended";
    transcriptSegmentCount?: number;
  }) {
    await db.insert(meetings).values({
      id: input.id,
      meetingLinkId: input.meetingLinkId,
      title: "Meeting",
      startedByUserId: input.startedByUserId ?? "user-1",
      spaceId: input.spaceId,
      spaceKind: input.spaceKind,
      status: input.status ?? "open",
      billingPrincipalType: input.billingPrincipalType ?? "user",
      billingPrincipalId: input.billingPrincipalId ?? "user-1",
      billingPlan: input.billingPlan ?? "free",
      allowGuests: false,
      recordingEnabled: false,
      joinPolicy: "open",
      activeEgressId: null,
      startedAt: NOW,
      endedAt: input.status === "ended" ? NOW : null,
      retainUntil: null,
      updatedAt: NOW,
    } as typeof meetings.$inferInsert);
  }

  describe("Composite Foreign Key Spatial Integrity", () => {
    it("enforces meeting_links_space_kind_fk ([spaceId, spaceKind] matches spaces[id, kind])", async () => {
      // Valid link with matching spaceId and spaceKind
      await db.insert(meetingLinks).values({
        id: "link-valid-1",
        code: "val-link-one",
        spaceId: "space-personal-1",
        spaceKind: "personal",
        allowGuests: true,
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Invalid link with mismatched spaceKind (space-personal-1 has kind 'personal', not 'shared')
      await expect(
        db.insert(meetingLinks).values({
          id: "link-invalid-1",
          code: "inv-link-one",
          spaceId: "space-personal-1",
          spaceKind: "shared",
          allowGuests: false,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).rejects.toThrow();
    });

    it("enforces meetings_link_space_fk ([meetingLinkId, spaceId] matches meetingLinks[id, spaceId])", async () => {
      // Valid meeting where meeting.spaceId matches link.spaceId
      await insertMeeting({
        id: "meeting-valid-1",
        spaceId: "space-shared-1",
        spaceKind: "shared",
        meetingLinkId: "link-shared-std",
      });

      // Cross-tenant injection attempt: meeting in space-personal-1 referencing link in space-shared-1
      await expect(
        insertMeeting({
          id: "meeting-invalid-1",
          spaceId: "space-personal-1",
          spaceKind: "personal",
          meetingLinkId: "link-shared-std",
        }),
      ).rejects.toThrow();
    });
  });

  describe("Atomic SQLite Projection Triggers", () => {
    it("transcripts_meeting_projection_insert automatically increments transcript_segment_count and updates timestamp", async () => {
      const meetingId = "meeting-proj-test";
      await insertMeeting({
        id: meetingId,
        spaceId: "space-shared-1",
        spaceKind: "shared",
        meetingLinkId: "link-shared-std",
        transcriptSegmentCount: 0,
      });

      // Add admission & connection
      const admissionId = "adm-proj-1";
      const connectionId = "conn-proj-1";
      await db.insert(meetingAdmissions).values({
        id: admissionId,
        meetingId,
        subjectType: "user",
        subjectUserId: "user-1",
        displayName: "Alice",
        admissionStatus: "approved",
        decidedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await db.insert(meetingConnections).values({
        id: connectionId,
        meetingId,
        admissionId,
        livekitIdentity: "alice-identity",
        userId: "user-1",
        role: "attendee",
        connectionStatus: "live",
        tokenIssuedAt: NOW,
        connectedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Verify initial state
      let [meetingRow] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
      expect(meetingRow.transcriptSegmentCount).toBe(0);
      expect(meetingRow.transcriptLastIngestedAt).toBeNull();

      // Insert 3 transcript segments in one batch
      const segmentRows = [
        {
          id: generateId("TRANSCRIPT"),
          meetingId,
          admissionId,
          connectionId,
          participantIdentity: "alice-identity",
          participantName: "Alice",
          text: "First spoken phrase",
          segmentId: "deepgram:s1",
          startedAt: NOW,
          updatedAt: new Date(NOW.getTime() + 1_000),
        },
        {
          id: generateId("TRANSCRIPT"),
          meetingId,
          admissionId,
          connectionId,
          participantIdentity: "alice-identity",
          participantName: "Alice",
          text: "Second spoken phrase",
          segmentId: "deepgram:s2",
          startedAt: new Date(NOW.getTime() + 2_000),
          updatedAt: new Date(NOW.getTime() + 3_000),
        },
        {
          id: generateId("TRANSCRIPT"),
          meetingId,
          admissionId,
          connectionId,
          participantIdentity: "alice-identity",
          participantName: "Alice",
          text: "Third spoken phrase",
          segmentId: "deepgram:s3",
          startedAt: new Date(NOW.getTime() + 4_000),
          updatedAt: new Date(NOW.getTime() + 5_000),
        },
      ];

      for (const insert of boundedStatements(segmentRows, (chunk) => db.insert(transcripts).values(chunk))) {
        await insert;
      }

      // Check meeting row projection updated by SQLite trigger
      [meetingRow] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
      expect(meetingRow.transcriptSegmentCount).toBe(3);
      expect(meetingRow.transcriptLastIngestedAt?.getTime()).toBe(NOW.getTime() + 5_000);
    });

    it("spaces_kind_immutable_check prevents mutating space kind", async () => {
      // Attempting to change personal space to shared space
      await expect(
        db.update(spaces).set({ kind: "shared" as const }).where(eq(spaces.id, "space-personal-1")),
      ).rejects.toThrow();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emulatedSyncServer, installFakeSyncServer } from "@/test/fake-sync-server";
import { TEST_WHITEBOARD_D1_ENV } from "@/test/whiteboard-d1-env";
import {
  meetingArtifacts,
  meetings,
  meetingLinks,
  organizationMembers,
  organizations,
  spaceMembers,
  spaces,
  users,
  whiteboardAssetReferences,
  whiteboardAssets,
  whiteboards,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {
  cleanupArchivedSpace,
  purgeSpace,
  resumeStrandedSpacePurges,
} from "./cleanup.server";
import { requestSpaceDeletion } from "@/modules/spaces/server/deletion.server";
import { immediateJobStep } from "@/test/jobs";

let db: TestDb;
const appDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedSpace() {
  const now = new Date("2026-06-01T00:00:00.000Z");
  await db.insert(users).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    normalizedEmail: "owner@example.com",
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaces).values({
    kind: "shared",
    id: "space_1",
    slug: "space_1-slug",
    name: "Space",
    ownerUserId: "owner",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaceMembers).values({
    id: "member_owner",
    spaceId: "space_1",
    userId: "owner",
    role: "admin",
    joinedAt: now,
  });
  await db.insert(meetingLinks).values({
    id: "room_1",
    code: "abc-defg-hij",
    spaceId: "space_1",
spaceKind: "shared" as const,
    title: "Space",
    allowGuests: false,
    joinPolicy: "open",
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
    reusePolicy: "reusable",
  });
  return now;
}

async function seedOrganizationSpace() {
  const now = new Date("2026-06-01T00:00:00.000Z");
  await db.insert(users).values([
    {
      id: "org_owner",
      name: "Org Owner",
      email: "org-owner@example.com",
      normalizedEmail: "org-owner@example.com",
      plan: "organization",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "org_admin",
      name: "Org Admin",
      email: "org-admin@example.com",
      normalizedEmail: "org-admin@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "org_member",
      name: "Org Member",
      email: "org-member@example.com",
      normalizedEmail: "org-member@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "teacher",
      name: "Teacher",
      email: "teacher@example.com",
      normalizedEmail: "teacher@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(organizations).values({
    id: "org_1",
    name: "University",
    ownerId: "org_owner",
    plan: "organization",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(organizationMembers).values([
    {
      id: "org_admin_membership",
      organizationId: "org_1",
      userId: "org_admin",
      role: "admin",
      joinedAt: now,
    },
    {
      id: "org_member_membership",
      organizationId: "org_1",
      userId: "org_member",
      role: "member",
      joinedAt: now,
    },
  ]);
  await db.insert(spaces).values({
    kind: "shared",
    id: "space_org",
    slug: "space_org-slug",
    name: "Teacher Space",
    ownerUserId: null,
    organizationId: "org_1",
    createdAt: now,
    updatedAt: now,
  });
  return now;
}

describe("archived Space deletion", () => {
  it("atomically archives the Space and its meeting links before cleanup", async () => {
    await seedSpace();
    const archivedAt = new Date("2026-06-02T00:00:00.000Z");

    await expect(
      requestSpaceDeletion(appDb(), "space_1", "owner", archivedAt),
    ).resolves.toBe(true);
    await expect(
      db.query.spaces.findFirst({ where: { id: "space_1" } }),
    ).resolves.toMatchObject({ archivedAt });
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "room_1" } }),
    ).resolves.toMatchObject({ archivedAt });
  });

  it("does not let a Space admin perform an Organization governance deletion", async () => {
    const now = await seedOrganizationSpace();
    await db.insert(spaceMembers).values({
      id: "member_teacher",
      spaceId: "space_org",
      userId: "teacher",
      role: "admin",
      joinedAt: now,
    });

    const archivedAt = new Date("2026-06-02T00:00:00.000Z");

    await expect(
      requestSpaceDeletion(appDb(), "space_org", "teacher", archivedAt),
    ).resolves.toBe(false);
    await expect(
      db.query.spaces.findFirst({ where: { id: "space_org" } }),
    ).resolves.toMatchObject({ archivedAt: null });
  });

  it.each([
    ["owner", "org_owner"],
    ["admin", "org_admin"],
  ])(
    "allows an Organization %s to archive without direct Space membership",
    async (_role, userId) => {
      await seedOrganizationSpace();
      const archivedAt = new Date("2026-06-02T00:00:00.000Z");

      await expect(
        requestSpaceDeletion(appDb(), "space_org", userId, archivedAt),
      ).resolves.toBe(true);
      await expect(
        db.query.spaces.findFirst({ where: { id: "space_org" } }),
      ).resolves.toMatchObject({ archivedAt });
    },
  );

  it("rejects an Organization member without direct Space admin authority", async () => {
    await seedOrganizationSpace();
    const archivedAt = new Date("2026-06-02T00:00:00.000Z");

    await expect(
      requestSpaceDeletion(appDb(), "space_org", "org_member", archivedAt),
    ).resolves.toBe(false);
    await expect(
      db.query.spaces.findFirst({ where: { id: "space_org" } }),
    ).resolves.toMatchObject({ archivedAt: null });
  });

  it("retains ownership metadata after an R2 failure and resumes cleanly", async () => {
    const startedAt = await seedSpace();
    const endedAt = new Date(startedAt.getTime() + 60_000);
    await db.insert(meetings).values({
      id: "meeting_1",
      meetingLinkId: "room_1",
      startedByUserId: null,
      spaceId: "space_1",
    spaceKind: "shared" as const,
      status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "host",
    billingPlan: "free",
      allowGuests: false,
      recordingEnabled: false,
      joinPolicy: "open",
      startedAt,
      endedAt,
      updatedAt: endedAt,
    });
    await db.insert(meetingArtifacts).values({
      id: "artifact_1",
      meetingId: "meeting_1",
      spaceId: "space_1",
      type: "whiteboard_pdf",
      r2Key: "meetings/meeting_1/exports/whiteboard.pdf",
      filename: "whiteboard.pdf",
      mimeType: "application/pdf",
      size: 10,
      uploadedByUserId: "owner",
      createdAt: endedAt,
    });
    await requestSpaceDeletion(appDb(), "space_1", "owner", endedAt);

    const failingBucket = {
      delete: async () => {
        throw new Error("R2 unavailable");
      },
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as R2Bucket;
    await expect(
      cleanupArchivedSpace(appDb(), { R2_BUCKET: failingBucket } as Env, "space_1"),
    ).rejects.toThrow("R2 unavailable");
    await expect(
      db.query.spaces.findFirst({ where: { id: "space_1" } }),
    ).resolves.toBeDefined();
    await expect(
      db.query.meetingArtifacts.findFirst({ where: { id: "artifact_1" } }),
    ).resolves.toBeDefined();

    const deletedKeys: string[] = [];
    const workingBucket = {
      delete: async (keys: string | string[]) => {
        deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
      },
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as R2Bucket;
    await expect(
      cleanupArchivedSpace(appDb(), { R2_BUCKET: workingBucket } as Env, "space_1"),
    ).resolves.toBe("progress");
    await expect(
      cleanupArchivedSpace(appDb(), { R2_BUCKET: workingBucket } as Env, "space_1"),
    ).resolves.toBe("done");

    expect(deletedKeys).toContain("meetings/meeting_1/exports/whiteboard.pdf");
    await expect(
      db.query.spaces.findFirst({ where: { id: "space_1" } }),
    ).resolves.toBeUndefined();
  });

  it("retains R2 objects still referenced by a board outside the delete batch", async () => {
    const now = await seedSpace();
    // space_2 survives and keeps referencing an asset that space_1's board owns.
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_2",
      slug: "space-2-slug",
      name: "Space 2",
      ownerUserId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(whiteboards).values([
      // board_a owns the assets; board_c also lives in the deleted space.
      { id: "board_a", syncRoomId: "room_a", spaceId: "space_1", title: "A", status: "active", createdAt: now, updatedAt: now },
      { id: "board_c", syncRoomId: "room_c", spaceId: "space_1", title: "C", status: "active", createdAt: now, updatedAt: now },
      { id: "board_b", syncRoomId: "room_b", spaceId: "space_2", title: "B", status: "active", createdAt: now, updatedAt: now },
    ]);
    // The copy references below could only have been created while board_a's
    // registry proved the bytes committed; the migration trigger enforces that.
    await db.insert(whiteboardAssets).values([
      {
        id: "asset_gone",
        whiteboardId: "board_a",
        spaceId: "space_1",
        r2Key: "whiteboards/board_a/assets/gone.png",
        filename: "gone.png",
        mimeType: "image/png",
        size: 10,
        status: "committed",
        uploadedByUserId: null,
        guestAdmissionId: null,
        expiresAt: null,
        committedAt: now,
        createdAt: now,
      },
      {
        id: "asset_keep",
        whiteboardId: "board_a",
        spaceId: "space_1",
        r2Key: "whiteboards/board_a/assets/keep.png",
        filename: "keep.png",
        mimeType: "image/png",
        size: 10,
        status: "committed",
        uploadedByUserId: null,
        guestAdmissionId: null,
        expiresAt: null,
        committedAt: now,
        createdAt: now,
      },
    ]);
    await db.insert(whiteboardAssetReferences).values([
      // Referenced only by another in-batch board → its R2 object must go.
      {
        id: "ref_gone",
        whiteboardId: "board_c",
        sourceWhiteboardId: "board_a",
        r2Key: "whiteboards/board_a/assets/gone.png",
        createdAt: now,
      },
      // Sourced from the deleted board but still referenced by a surviving board
      // in another space → its R2 object must be retained.
      {
        id: "ref_keep",
        whiteboardId: "board_b",
        sourceWhiteboardId: "board_a",
        r2Key: "whiteboards/board_a/assets/keep.png",
        createdAt: now,
      },
    ]);

    await requestSpaceDeletion(appDb(), "space_1", "owner", now);

    const deletedKeys: string[] = [];
    const bucket = {
      delete: async (keys: string | string[]) => {
        deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
      },
      list: async ({ prefix }: { prefix: string }) => ({
        objects:
          prefix === "whiteboards/board_a/"
            ? [
                { key: "whiteboards/board_a/assets/gone.png" },
                { key: "whiteboards/board_a/assets/keep.png" },
              ]
            : [],
        truncated: false,
      }),
    } as unknown as R2Bucket;

    const rooms = new Map([["board_a", "{}"]]);
    installFakeSyncServer(emulatedSyncServer(new Map(), rooms));
    const env = { ...TEST_WHITEBOARD_D1_ENV, R2_BUCKET: bucket } as unknown as Env;
    // The purge job runs passes until the Space is gone; none of them waits.
    const step = immediateJobStep();
    await purgeSpace(step, appDb(), env, { kind: "purgeSpace", spaceId: "space_1", requestedAt: 0 });
    expect(step.sleeps).toEqual([]);
    await expect(db.query.spaces.findFirst({ where: { id: "space_1" } })).resolves.toBeUndefined();

    // The board itself, its room on the sync node, is deleted with it.
    expect(rooms.has("board_a")).toBe(false);
    expect(deletedKeys).toContain("whiteboards/board_a/assets/gone.png");
    expect(deletedKeys).not.toContain("whiteboards/board_a/assets/keep.png");
    await expect(
      db.query.whiteboards.findFirst({ where: { id: "board_a" } }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.whiteboardAssetReferences.findFirst({ where: { id: "ref_keep" } }),
    ).resolves.toBeDefined();
  });
});

describe("stranded Space purge sweep", () => {
  it("starts the purge of a Space archived past the grace period, and only that", async () => {
    await seedSpace();
    const archivedAt = new Date("2026-06-02T00:00:00.000Z");
    await requestSpaceDeletion(appDb(), "space_1", "owner", archivedAt);
    // A Workflow binding that records what is started.
    const started: unknown[] = [];
    const env = {
      JOBS: { create: async ({ params }: { params: unknown }) => { started.push(params); } },
    } as unknown as Pick<Env, "JOBS">;

    // Within the hour the deletion request's own job is still the one at work.
    await expect(resumeStrandedSpacePurges(appDb(), env, new Date(archivedAt.getTime() + 30 * 60_000)))
      .resolves.toBe(0);
    await expect(resumeStrandedSpacePurges(appDb(), env, new Date(archivedAt.getTime() + 2 * 60 * 60_000)))
      .resolves.toBe(1);
    expect(started).toEqual([{ kind: "purgeSpace", spaceId: "space_1", requestedAt: archivedAt.getTime() }]);
  });
});

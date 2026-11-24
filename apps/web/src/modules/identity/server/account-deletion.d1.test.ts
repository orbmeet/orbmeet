import { describe, expect, it, vi } from "vitest";
import {
  meetingAdmissions,
  meetingArtifacts,
  meetingLinks,
  meetings,
  meetingWhiteboards,
  files,
  spaces,
  users,
  r2ObjectCleanupTasks,
  whiteboardAssetReferences,
  whiteboardAssets,
  whiteboards,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import {
  ACCOUNT_UPLOAD_URL_GRACE_MS,
  cleanupAccountR2Objects,
  loadAccountStorageScope,
  runAccountCleanup,
  type AccountStorageScope,
} from "./account-deletion.server";
import { immediateJobStep } from "@/test/jobs";

/** Records which boards' rooms the cleanup deleted. */
function roomPurger() {
  const purged: string[] = [];
  return { purged, purge: async (whiteboardId: string) => void purged.push(whiteboardId) };
}

function createBucket(initialKeys: string[]) {
  const keys = new Set(initialKeys);
  const bucket = {
    delete: vi.fn(async (input: string | string[]) => {
      for (const key of Array.isArray(input) ? input : [input]) keys.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix?: string }) => ({
      objects: [...keys]
        .filter((key) => key.startsWith(prefix ?? ""))
        .map((key) => ({ key })),
      truncated: false,
    })),
  } as unknown as R2Bucket;
  return { bucket, keys };
}

async function seedAccountDeletionData() {
  const db = await createTestDb();
  const now = new Date();
  await db.insert(users).values([
    {
      id: "owner",
      name: "Owner",
      email: "owner@example.com",
      normalizedEmail: "owner@example.com",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "member",
      name: "Member",
      email: "member@example.com",
      normalizedEmail: "member@example.com",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(spaces).values({
    kind: "shared",
    id: "space_1",
    slug: "space_1-slug",
    name: "Shared",
    ownerUserId: "member",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, "owner");
  await db.insert(meetingLinks).values({
    id: "link_1",
    code: "abc-defg-hij",
    spaceId: "owner_space",
spaceKind: "personal" as const,
    title: "Meeting",
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: "meeting_1",
    meetingLinkId: "link_1",
    spaceId: "owner_space",
    spaceKind: "personal" as const,
    startedByUserId: "owner",
    title: "Meeting",
    status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "owner",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    endedAt: now,
    updatedAt: now,
  });
  await db.insert(meetingAdmissions).values([
    {
      id: "admission_member",
      meetingId: "meeting_1",
      subjectType: "user",
      subjectUserId: "member",
      displayName: "Member",
      admissionStatus: "approved",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "admission_guest",
      meetingId: "meeting_1",
      subjectType: "guest",
      guestSecretHash: "hash",
      displayName: "Guest",
      admissionStatus: "approved",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(meetingArtifacts).values({
    id: "artifact_1",
    meetingId: "meeting_1",
    spaceId: "owner_space",
    type: "recording",
    r2Key: "meetings/meeting_1/recordings/meeting.mp4",
    filename: "meeting.mp4",
    mimeType: "video/mp4",
    size: 100,
    uploadedByUserId: "owner",
    createdAt: now,
  });
  await db.insert(files).values({
    id: "asset_1",
    spaceId: "space_1",
    type: "pdf",
    r2Key: "spaces/space_1/uploads/asset_1.pdf",
    filename: "owner.pdf",
    mimeType: "application/pdf",
    size: 100,
    uploadedByUserId: "owner",
    createdAt: now,
  });
  return db;
}

/** The deletion workflow's two steps: the scope, read once, then the release. */
async function releaseOwnerStorage(db: TestDb, bucket: R2Bucket): Promise<AccountStorageScope> {
  const scope = await loadAccountStorageScope(db, { meetingLinkIds: ["link_1"], personalSpaceId: "owner_space" });
  await cleanupAccountR2Objects(db, { R2_BUCKET: bucket }, "owner", { ...scope, personalSpaceId: "owner_space" });
  return scope;
}

describe("cleanupAccountR2Objects", () => {
  it("deletes more pending Whiteboard assets than one D1 statement can bind", async () => {
    const db = await seedAccountDeletionData();
    const now = new Date();
    await db.insert(whiteboards).values({
      id: "whiteboard_many_pending",
      syncRoomId: "whiteboard_many_pending",
      spaceId: "owner_space",
      title: "Many pending uploads",
      createdByUserId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    const keys: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const r2Key = `whiteboards/whiteboard_many_pending/assets/${index}.png`;
      keys.push(r2Key);
      await db.insert(whiteboardAssets).values({
        id: `pending_asset_${index}`,
        whiteboardId: "whiteboard_many_pending",
        spaceId: "owner_space",
        r2Key,
        filename: `${index}.png`,
        mimeType: "image/png",
        size: 1,
        status: "pending",
        uploadedByUserId: "owner",
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
      });
    }
    const { bucket } = createBucket(keys);

    await expect(releaseOwnerStorage(db, bucket)).resolves.toEqual({
      meetingIds: ["meeting_1"],
      whiteboardIds: ["whiteboard_many_pending"],
    });
    await expect(db.select().from(whiteboardAssets)).resolves.toEqual([]);
  });

  it("deletes personal aggregates while preserving content owned by a shared Space", async () => {
    const db = await seedAccountDeletionData();
    const { bucket, keys } = createBucket([
      "meetings/meeting_1/recordings/meeting.mp4",
      "meetings/meeting_1/recordings/untracked.mp4",
      "meetings/meeting_1/recordings/pending.mp4",
      "meetings/meeting_1/recorder/snapshot.png",
      "meetings/meeting_1/exports/whiteboard/revision_1.pdf",
      "spaces/space_1/uploads/asset_1.pdf",
      "meetings/unrelated/recordings/keep.mp4",
      "spaces/unrelated/files/asset_keep/keep.png",
    ]);

    await releaseOwnerStorage(db, bucket);

    expect([...keys]).toEqual([
      "spaces/space_1/uploads/asset_1.pdf",
      "meetings/unrelated/recordings/keep.mp4",
      "spaces/unrelated/files/asset_keep/keep.png",
    ]);
    expect(
      await db.query.meetingArtifacts.findFirst({
        where: { id: "artifact_1" },
      }),
    ).toBeUndefined();
    expect(
      await db.query.files.findFirst({
        where: { id: "asset_1" },
      }),
    ).toBeDefined();
  });

  it("releases the same boards and meetings when retried after their rows are gone", async () => {
    const db = await seedAccountDeletionData();
    const now = new Date();
    await db.insert(whiteboards).values({
      id: "whiteboard_personal",
      syncRoomId: "whiteboard_personal",
      spaceId: "owner_space",
      title: "Personal",
      createdByUserId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    const scope = await loadAccountStorageScope(db, { meetingLinkIds: ["link_1"], personalSpaceId: "owner_space" });
    const { bucket } = createBucket([]);

    await cleanupAccountR2Objects(db, { R2_BUCKET: bucket }, "owner", { ...scope, personalSpaceId: "owner_space" });
    // A retry of the step, as after a failure that came after the deletes.
    const { bucket: retried, keys } = createBucket([
      "meetings/meeting_1/recordings/late.mp4",
      "whiteboards/whiteboard_personal/assets/late.png",
    ]);
    await cleanupAccountR2Objects(db, { R2_BUCKET: retried }, "owner", { ...scope, personalSpaceId: "owner_space" });

    expect(scope).toEqual({ meetingIds: ["meeting_1"], whiteboardIds: ["whiteboard_personal"] });
    expect(keys.size).toBe(0);
    await expect(db.select().from(whiteboards)).resolves.toEqual([]);
    await expect(db.select().from(meetings)).resolves.toEqual([]);
  });

  it("deletes a personal board that was shown in a personal meeting", async () => {
    const db = await seedAccountDeletionData();
    const now = new Date();
    await db.insert(whiteboards).values({
      id: "whiteboard_presented",
      syncRoomId: "whiteboard_presented",
      spaceId: "owner_space",
      title: "Presented",
      createdByUserId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetingWhiteboards).values({
      id: "usage_presented",
      meetingId: "meeting_1",
      spaceId: "owner_space",
      whiteboardId: "whiteboard_presented",
      attachedAt: now,
    });
    const { bucket } = createBucket([]);

    await releaseOwnerStorage(db, bucket);

    await expect(db.select().from(meetingWhiteboards)).resolves.toEqual([]);
    await expect(db.select().from(whiteboards)).resolves.toEqual([]);
    await expect(db.select().from(meetings)).resolves.toEqual([]);
  });

  it("queues what a personal board borrowed from another board before deleting it", async () => {
    const db = await seedAccountDeletionData();
    const now = new Date();
    await db.insert(whiteboards).values([
      {
        id: "whiteboard_source",
        syncRoomId: "whiteboard_source",
        spaceId: "space_1",
        title: "Shared original",
        createdByUserId: "member",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "whiteboard_personal",
        syncRoomId: "whiteboard_personal",
        spaceId: "owner_space",
        title: "Personal copy",
        createdByUserId: "owner",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const borrowed = "whiteboards/whiteboard_source/assets/diagram.png";
    await db.insert(whiteboardAssets).values({
      id: "source_asset",
      whiteboardId: "whiteboard_source",
      spaceId: "space_1",
      r2Key: borrowed,
      filename: "diagram.png",
      mimeType: "image/png",
      size: 1,
      status: "committed",
      uploadedByUserId: "member",
      committedAt: now,
      createdAt: now,
    });
    await db.insert(whiteboardAssetReferences).values({
      id: "reference_1",
      whiteboardId: "whiteboard_personal",
      sourceWhiteboardId: "whiteboard_source",
      r2Key: borrowed,
      createdAt: now,
    });
    // The original is deleted, and the copy's reference is now the object's
    // last owner.
    await db.delete(whiteboards).where(eq(whiteboards.id, "whiteboard_source"));
    const { bucket } = createBucket([borrowed]);

    await releaseOwnerStorage(db, bucket);

    await expect(db.select().from(whiteboardAssetReferences)).resolves.toEqual([]);
    await expect(db.select({ r2Key: r2ObjectCleanupTasks.r2Key }).from(r2ObjectCleanupTasks))
      .resolves.toEqual([{ r2Key: borrowed }]);
  });

  it("propagates R2 failures so relational deletion can be retried", async () => {
    const db = await seedAccountDeletionData();
    const bucket = {
      delete: vi.fn().mockRejectedValue(new Error("r2 unavailable")),
      list: vi.fn(),
    } as unknown as R2Bucket;

    await expect(
      releaseOwnerStorage(db, bucket),
    ).rejects.toThrow("r2 unavailable");
    expect(
      await db.query.meetingArtifacts.findFirst({
        where: { id: "artifact_1" },
      }),
    ).toBeDefined();
  });

  it("removes objects uploaded after erasure once every signed URL has expired", async () => {
    const db = await seedAccountDeletionData();
    const now = new Date("2026-07-29T00:00:00.000Z");
    const { bucket, keys } = createBucket([
      "spaces/owner_space/uploads/late.pdf",
      "meetings/meeting_1/recordings/late.mp4",
      "whiteboards/whiteboard_deleted/assets/late.png",
      "internal/whiteboards/whiteboard_deleted/state/1.json",
    ]);
    const step = immediateJobStep();
    const { purged, purge } = roomPurger();

    await runAccountCleanup(step, db, { R2_BUCKET: bucket }, {
      personalSpaceId: "owner_space",
      meetingIds: ["meeting_1"],
      whiteboardIds: ["whiteboard_deleted"],
      requestedAt: now.getTime(),
    }, purge);

    // It waits out every upload URL the account could still hold first.
    expect(step.sleeps).toEqual([{ name: "let upload URLs expire", at: now.getTime() + ACCOUNT_UPLOAD_URL_GRACE_MS }]);
    expect(keys.size).toBe(0);
    // The board itself is its room on the sync node.
    expect(purged).toEqual(["whiteboard_deleted"]);
  });

  it("deletes an account's prefixes in batches, so its step count stays bounded", async () => {
    const db = await seedAccountDeletionData();
    const whiteboardIds = Array.from({ length: 120 }, (_, index) => `whiteboard_${index}`);
    const { bucket, keys } = createBucket(whiteboardIds.map((id) => `whiteboards/${id}/assets/a.png`));
    const step = immediateJobStep();
    const { purged, purge } = roomPurger();

    await runAccountCleanup(step, db, { R2_BUCKET: bucket }, {
      personalSpaceId: "owner_space",
      meetingIds: ["meeting_1"],
      whiteboardIds,
      requestedAt: Date.now(),
    }, purge);

    // 120 rooms and 243 prefixes, 50 to a step.
    expect(step.names).toHaveLength(3 + 5);
    expect(keys.size).toBe(0);
    expect(purged).toEqual(whiteboardIds);
  });
});

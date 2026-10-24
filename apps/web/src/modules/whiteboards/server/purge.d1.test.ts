import { afterEach, describe, expect, it, vi } from "vitest";
import {
  users,
  whiteboardAssetReferences,
  whiteboardAssets,
  whiteboards,
} from "@orbmeet/db/schema";
import { createTestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { immediateJobStep } from "@/test/jobs";
import { emulatedSyncServer, installFakeSyncServer } from "@/test/fake-sync-server";
import { TEST_WHITEBOARD_D1_ENV } from "@/test/whiteboard-d1-env";
import type { Job } from "@/platform/jobs/jobs";
import { runJob } from "@/app/jobs/run-job.server";
import { deleteArchivedWhiteboardImpl } from "./api.server";
import { startWhiteboardPurge } from "./purge.server";
import { cleanupFailedWhiteboardCopy } from "./documents";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SOURCE_OBJECTS = {
  "internal/whiteboards/whiteboard_source/state/current.json": "{}",
  "internal/whiteboards/whiteboard_source/state/versions/0000000000000001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json": "{}",
  "whiteboards/whiteboard_source/assets/page-1.png": "image-bytes",
  "whiteboards/whiteboard_source/assets/page-2.png": "image-bytes",
  "whiteboards/whiteboard_source/revisions/whiteboard_revision_1.json": "{}",
};

/** An R2 bucket whose next `failingLists` listings fail, as R2 does in an incident. */
function fakeBucket(initial: Record<string, string>) {
  const objects = new Map(Object.entries(initial));
  const bucket = {
    objects,
    failingLists: 0,
    async head(key: string) {
      return objects.has(key) ? { size: 1 } : null;
    },
    async delete(keys: string[] | string) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list(options: { prefix?: string } = {}) {
      if (bucket.failingLists > 0) {
        bucket.failingLists -= 1;
        throw new Error("R2 responded 503");
      }
      const prefix = options.prefix ?? "";
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })),
        truncated: false,
      };
    },
  };
  return bucket;
}

/**
 * A `JOBS` binding that records what was started (the test runs it, as a
 * Workflow later would), and a sync node holding the boards' rooms.
 */
function envWith(bucket: unknown) {
  const started: Job[] = [];
  const rooms = new Map([["whiteboard_source", "{}"], ["whiteboard_rolled_back", "{}"]]);
  installFakeSyncServer(emulatedSyncServer(new Map(), rooms));
  const env = {
    ...TEST_WHITEBOARD_D1_ENV,
    R2_BUCKET: bucket,
    JOBS: {
      create: async ({ params }: { params: Job }) => {
        started.push(params);
        return {};
      },
      get: async () => ({}),
    },
  } as unknown as Env;
  return { env, started, rooms };
}

async function seedArchivedBoard() {
  const db = await createTestDb();
  const now = new Date("2026-07-19T00:00:00.000Z");
  await db.insert(users).values({
    id: "user_owner",
    name: "Owner",
    email: "owner@example.com",
    normalizedEmail: "owner@example.com",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, "user_owner", { now });
  await db.insert(whiteboards).values({
    id: "whiteboard_source",
    syncRoomId: "whiteboard_source",
    spaceId: "user_owner_space",
    title: "Board",
    status: "archived",
    archivedAt: now,
    createdByUserId: "user_owner",
    createdAt: now,
    updatedAt: now,
  });
  return { db, now };
}

const deleteBoard = (db: Awaited<ReturnType<typeof createTestDb>>, env: Env) =>
  deleteArchivedWhiteboardImpl({
    data: { whiteboardId: "whiteboard_source" },
    context: { user: { id: "user_owner" }, db, env } as never,
  });

describe("purging a deleted Whiteboard's objects", () => {
  it("purges every object once the delete has landed, through R2 failures", async () => {
    const { db } = await seedArchivedBoard();
    const bucket = fakeBucket(SOURCE_OBJECTS);
    const { env, started, rooms } = envWith(bucket);

    await expect(deleteBoard(db, env)).resolves.toEqual({ success: true });
    expect(started).toEqual([expect.objectContaining({ kind: "purgeWhiteboard", whiteboardId: "whiteboard_source" })]);

    // R2 fails the first listings; the job's retries carry the purge through.
    bucket.failingLists = 3;
    await expect(runJob(immediateJobStep(), env, started[0])).resolves.toBe("purged");
    expect([...bucket.objects.keys()]).toEqual([]);
    // The board itself, its room on the sync node, is gone too.
    expect(rooms.has("whiteboard_source")).toBe(false);
  });

  it("keeps the objects of a board whose delete did not land", async () => {
    await seedArchivedBoard();
    const bucket = fakeBucket(SOURCE_OBJECTS);
    const { env, rooms } = envWith(bucket);

    // The purge is started ahead of the delete, which then never happens.
    const job = await startWhiteboardPurge(env, "whiteboard_source");
    await expect(runJob(immediateJobStep(), env, job)).resolves.toBe("kept");
    expect(bucket.objects.size).toBe(Object.keys(SOURCE_OBJECTS).length);
    expect(rooms.has("whiteboard_source")).toBe(true);
  });

  it("keeps the assets another board's copy still references", async () => {
    const { db, now } = await seedArchivedBoard();
    const referenced = "whiteboards/whiteboard_source/assets/page-1.png";
    await db.insert(whiteboardAssets).values({
      id: "asset_page_1",
      whiteboardId: "whiteboard_source",
      spaceId: "user_owner_space",
      r2Key: referenced,
      filename: "page-1.png",
      mimeType: "image/png",
      size: "image-bytes".length,
      status: "committed",
      uploadedByUserId: null,
      guestAdmissionId: null,
      expiresAt: null,
      committedAt: now,
      createdAt: now,
    });
    await db.insert(whiteboards).values({
      id: "whiteboard_copy",
      syncRoomId: "whiteboard_copy",
      spaceId: "user_owner_space",
      title: "Copy",
      status: "active",
      createdByUserId: "user_owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(whiteboardAssetReferences).values({
      id: "whiteboard_asset_ref_1",
      whiteboardId: "whiteboard_copy",
      sourceWhiteboardId: "whiteboard_source",
      r2Key: referenced,
      createdAt: now,
    });
    const bucket = fakeBucket(SOURCE_OBJECTS);
    const { env, started } = envWith(bucket);

    await deleteBoard(db, env);
    await expect(runJob(immediateJobStep(), env, started[0])).resolves.toBe("purged");
    expect([...bucket.objects.keys()]).toEqual([referenced]);
  });

  it("deletes the room of a copy that was rolled back", async () => {
    const { db } = await seedArchivedBoard();
    const bucket = fakeBucket(SOURCE_OBJECTS);
    const { env, started, rooms } = envWith(bucket);

    await cleanupFailedWhiteboardCopy(db, env, "whiteboard_rolled_back");
    await expect(runJob(immediateJobStep(), env, started[0])).resolves.toBe("purged");
    expect(rooms.has("whiteboard_rolled_back")).toBe(false);
    expect(rooms.has("whiteboard_source")).toBe(true);
    expect(bucket.objects.size).toBe(Object.keys(SOURCE_OBJECTS).length);
  });
});


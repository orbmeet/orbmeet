import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  users,
  whiteboardAssetReferences,
  whiteboardRevisionAssetReferences,
  whiteboardRevisions,
  whiteboards,
} from "@orbmeet/db/schema";

import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { buildWhiteboardPdfImportAssetKey } from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import {
  commitRevisionWhiteboardAssets,
  commitWhiteboardAsset,
  commitPdfImportAssets,
  isWhiteboardAssetReferencedByRevision,
  createPendingWhiteboardAsset,
  completeWhiteboardAssetDeletion,
  requestWhiteboardAssetDeletion,
  retireUnplacedPdfImportAssets,
  retireWhiteboardAssets,
} from "./assets";
import { cleanupWhiteboardAssetOperations } from "./asset-maintenance";

/** Minimal R2 stand-in: only the keys listed here have objects behind them. */
function createEnvWithObjects(sizeByKey: Record<string, number>): Env {
  return {
    R2_BUCKET: {
      head: (key: string) =>
        Promise.resolve(
          key in sizeByKey
            ? ({ size: sizeByKey[key], httpMetadata: { contentType: "image/png" } } as R2Object)
            : null,
        ),
    },
  } as unknown as Env;
}

let db: TestDb;
const getAppDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date("2026-07-22T00:00:00.000Z");
  await db.insert(users).values({
    id: "host",
    name: "Host",
    email: "host@example.com",
    normalizedEmail: "host@example.com",
    plan: "pro",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(getAppDb(), "host", { now });
  await db.insert(whiteboards).values({
    id: "whiteboard_1",
    syncRoomId: "whiteboard_1",
    spaceId: "host_space",
    title: "Board",
    status: "active",
    createdByUserId: "host",
    createdAt: now,
    updatedAt: now,
  });
});

describe("commitWhiteboardAsset", () => {
  it("commits an object whose size matches the upload reservation", async () => {
    await createPendingWhiteboardAsset(getAppDb(), {
      id: "asset_1",
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Key: "whiteboards/whiteboard_1/assets/asset_1.png",
      filename: "image.png",
      mimeType: "image/png",
      size: 123,
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
    });

    await expect(commitWhiteboardAsset(getAppDb(), {
      id: "asset_1",
      whiteboardId: "whiteboard_1",
      r2Key: "whiteboards/whiteboard_1/assets/asset_1.png",
      size: 123,
    })).resolves.toBeUndefined();

    await expect(db.query.whiteboardAssets.findFirst({
      where: { id: "asset_1" },
    })).resolves.toMatchObject({ status: "committed", size: 123 });
  });

  it("rejects an object whose size exceeds the upload reservation", async () => {
    await createPendingWhiteboardAsset(getAppDb(), {
      id: "asset_oversized",
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Key: "whiteboards/whiteboard_1/assets/asset_oversized.png",
      filename: "image.png",
      mimeType: "image/png",
      size: 123,
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
    });

    await expect(commitWhiteboardAsset(getAppDb(), {
      id: "asset_oversized",
      whiteboardId: "whiteboard_1",
      r2Key: "whiteboards/whiteboard_1/assets/asset_oversized.png",
      size: 124,
    })).rejects.toThrow("Failed to commit Whiteboard asset asset_oversized");

    await expect(db.query.whiteboardAssets.findFirst({
      where: { id: "asset_oversized" },
    })).resolves.toMatchObject({ status: "pending", size: 123 });
  });
});

describe("whiteboard asset deletion saga", () => {
  async function seedAsset(id: string) {
    await createPendingWhiteboardAsset(getAppDb(), {
      id,
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Key: `whiteboards/whiteboard_1/assets/${id}.png`,
      filename: "image.png",
      mimeType: "image/png",
      size: 123,
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
      now: new Date("2026-07-22T00:00:00.000Z"),
    });
  }

  it("persists deletion intent until external cleanup completes", async () => {
    await seedAsset("asset_delete");

    await expect(requestWhiteboardAssetDeletion(getAppDb(), {
      id: "asset_delete",
      whiteboardId: "whiteboard_1",
      from: "pending",
      now: new Date("2026-07-22T00:01:00.000Z"),
    })).resolves.toBe("requested");
    await expect(db.query.whiteboardAssets.findFirst({
      where: { id: "asset_delete" },
    })).resolves.toMatchObject({ status: "deleting" });

    await completeWhiteboardAssetDeletion(getAppDb(), {
      id: "asset_delete",
      whiteboardId: "whiteboard_1",
    });
    await expect(db.query.whiteboardAssets.findFirst({
      where: { id: "asset_delete" },
    })).resolves.toBeUndefined();
  });

  it("rolls back an asset within the second it was registered", async () => {
    await createPendingWhiteboardAsset(getAppDb(), {
      id: "asset_quick",
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Key: "whiteboards/whiteboard_1/assets/asset_quick.png",
      filename: "image.png",
      mimeType: "image/png",
      size: 123,
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
      now: new Date("2026-07-22T00:00:00.200Z"),
    });

    await expect(requestWhiteboardAssetDeletion(getAppDb(), {
      id: "asset_quick",
      whiteboardId: "whiteboard_1",
      from: "pending",
      now: new Date("2026-07-22T00:00:00.700Z"),
    })).resolves.toBe("requested");
  });

  it("cannot roll back an already committed asset", async () => {
    await seedAsset("asset_committed");
    await commitWhiteboardAsset(getAppDb(), {
      id: "asset_committed",
      whiteboardId: "whiteboard_1",
      r2Key: "whiteboards/whiteboard_1/assets/asset_committed.png",
      size: 123,
    });

    await expect(requestWhiteboardAssetDeletion(getAppDb(), {
      id: "asset_committed",
      whiteboardId: "whiteboard_1",
      from: "pending",
    })).resolves.toBe("committed");
    await expect(db.query.whiteboardAssets.findFirst({
      where: { id: "asset_committed" },
    })).resolves.toMatchObject({ status: "committed" });
  });

  it("cannot cross the deletion boundary after a revision pins the asset", async () => {
    await seedAsset("asset_pinned");
    const r2Key = "whiteboards/whiteboard_1/assets/asset_pinned.png";
    await commitWhiteboardAsset(getAppDb(), {
      id: "asset_pinned",
      whiteboardId: "whiteboard_1",
      r2Key,
      size: 123,
    });
    await db.insert(whiteboardRevisions).values({
      id: "revision_pinned",
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_1/revisions/revision_pinned.json",
      assetManifest: JSON.stringify([r2Key]),
      snapshotSize: 10,
      createdAt: new Date("2026-07-22T00:01:00.000Z"),
    });
    await db.insert(whiteboardRevisionAssetReferences).values({
      revisionId: "revision_pinned",
      r2Key,
      createdAt: new Date("2026-07-22T00:01:00.000Z"),
    });

    await expect(requestWhiteboardAssetDeletion(getAppDb(), {
      id: "asset_pinned",
      whiteboardId: "whiteboard_1",
      from: "committed",
    })).resolves.toBe("committed");
    await expect(db.query.whiteboardAssets.findFirst({
      where: { id: "asset_pinned" },
    })).resolves.toMatchObject({ status: "committed" });
  });

  it("cannot cross the deletion boundary after another board retains the asset", async () => {
    await seedAsset("asset_copied");
    const r2Key = "whiteboards/whiteboard_1/assets/asset_copied.png";
    await commitWhiteboardAsset(getAppDb(), {
      id: "asset_copied",
      whiteboardId: "whiteboard_1",
      r2Key,
      size: 123,
    });
    await db.insert(whiteboards).values({
      id: "whiteboard_2",
      syncRoomId: "whiteboard_2",
      spaceId: "host_space",
      title: "Copy",
      status: "active",
      createdByUserId: "host",
      createdAt: new Date("2026-07-22T00:01:00.000Z"),
      updatedAt: new Date("2026-07-22T00:01:00.000Z"),
    });
    await db.insert(whiteboardAssetReferences).values({
      id: "asset_reference_1",
      whiteboardId: "whiteboard_2",
      sourceWhiteboardId: "whiteboard_1",
      r2Key,
      createdAt: new Date("2026-07-22T00:01:00.000Z"),
    });

    await expect(requestWhiteboardAssetDeletion(getAppDb(), {
      id: "asset_copied",
      whiteboardId: "whiteboard_1",
      from: "committed",
    })).resolves.toBe("committed");
    await expect(db.query.whiteboardAssets.findFirst({
      where: { id: "asset_copied" },
    })).resolves.toMatchObject({ status: "committed" });
  });
});

describe("commitRevisionWhiteboardAssets", () => {
  const present = "whiteboards/whiteboard_1/assets/present.png";
  const alsoPresent = "whiteboards/whiteboard_1/assets/also-present.png";
  const dangling = "whiteboards/whiteboard_1/assets/dangling.png";

  it("registers every referenced object that exists", async () => {
    const env = createEnvWithObjects({ [present]: 100, [alsoPresent]: 200 });

    const result = await commitRevisionWhiteboardAssets(getAppDb(), env, {
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Keys: [present, alsoPresent],
    });

    expect(result.missingKeys).toEqual([]);
    expect(result.committedKeys.sort()).toEqual([alsoPresent, present].sort());
    await expect(db.query.whiteboardAssets.findFirst({
      where: { r2Key: present },
    })).resolves.toMatchObject({ status: "committed", size: 100 });
  });

  it("commits a pending row rather than inserting a duplicate", async () => {
    await createPendingWhiteboardAsset(getAppDb(), {
      id: "asset_pending",
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Key: present,
      filename: "image.png",
      mimeType: "image/png",
      size: 100,
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
    });
    const env = createEnvWithObjects({ [present]: 100 });

    await commitRevisionWhiteboardAssets(getAppDb(), env, {
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Keys: [present],
    });

    const rows = await db.query.whiteboardAssets.findMany({ where: { r2Key: present } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "asset_pending", status: "committed" });
  });

  it("reports a dangling reference instead of failing the whole capture", async () => {
    // The manifest is derived by scanning the snapshot, so it picks up keys left
    // by a rolled-back upload. Throwing here used to cost the board's entire
    // revision — the capture task retried to exhaustion and history was lost.
    const env = createEnvWithObjects({ [present]: 100 });

    const result = await commitRevisionWhiteboardAssets(getAppDb(), env, {
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Keys: [present, dangling],
    });

    expect(result.committedKeys).toEqual([present]);
    expect(result.missingKeys).toEqual([dangling]);
    await expect(db.query.whiteboardAssets.findFirst({
      where: { r2Key: dangling },
    })).resolves.toBeUndefined();
  });

  it("ignores keys belonging to another whiteboard", async () => {
    const foreign = "whiteboards/whiteboard_other/assets/foreign.png";
    const env = createEnvWithObjects({ [present]: 100, [foreign]: 300 });

    const result = await commitRevisionWhiteboardAssets(getAppDb(), env, {
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Keys: [present, foreign],
    });

    expect(result.committedKeys).toEqual([present]);
    expect(result.missingKeys).toEqual([]);
    await expect(db.query.whiteboardAssets.findFirst({
      where: { r2Key: foreign },
    })).resolves.toBeUndefined();
  });
});

describe("commitPdfImportAssets", () => {
  const importId = "cae07632-4d82-4de0-848f-501bd7586496";
  const pagesFor = (pageCount: number, size = 42) =>
    Array.from({ length: pageCount }, (_, index) => ({
      r2Key: buildWhiteboardPdfImportAssetKey("whiteboard_1", importId, index + 1),
      size,
    }));
  const commit = (pages: Array<{ r2Key: string; size: number }>) =>
    commitPdfImportAssets(getAppDb(), {
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      importId,
      pages,
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
    });

  it("registers every page of the largest import, past D1's bound-parameter cap, as committed", async () => {
    const pages = pagesFor(WHITEBOARD_CONFIG.MAX_PAGES);
    await commit(pages);

    const rows = await db.query.whiteboardAssets.findMany({ where: { whiteboardId: "whiteboard_1" } });
    expect(rows).toHaveLength(pages.length);
    expect(rows.every((row) => row.status === "committed" && row.size === 42 && row.expiresAt === null)).toBe(true);
    expect(new Set(rows.map((row) => row.r2Key))).toEqual(new Set(pages.map((page) => page.r2Key)));
  });

  it("replays a retried batch without duplicating it", async () => {
    await commit(pagesFor(16));
    await commit(pagesFor(16));
    expect(await db.query.whiteboardAssets.findMany({ where: { whiteboardId: "whiteboard_1" } }))
      .toHaveLength(16);
  });

  it("refuses a retry that describes a different object", async () => {
    await commit(pagesFor(2, 42));
    await expect(commit(pagesFor(2, 43))).rejects.toThrow("Failed to register PDF import page");
  });
});

describe("retireUnplacedPdfImportAssets", () => {
  const importId = "cae07632-4d82-4de0-848f-501bd7586496";
  const otherImportId = "11111111-2222-4333-8444-555555555555";
  const key = (page: number, id = importId) => buildWhiteboardPdfImportAssetKey("whiteboard_1", id, page);
  const register = (id: string, pages: number[]) =>
    commitPdfImportAssets(getAppDb(), {
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      importId: id,
      pages: pages.map((page) => ({ r2Key: key(page, id), size: 10 })),
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
    });

  it("retires this import's pages the board does not hold, and nothing else", async () => {
    await register(importId, [1, 2, 3, 4]);
    await register(otherImportId, [1]);

    await retireUnplacedPdfImportAssets(getAppDb(), {
      whiteboardId: "whiteboard_1",
      importId,
      placedKeys: [key(1), key(2)],
      now: new Date(Date.now() + 60_000),
    });

    const rows = await db.query.whiteboardAssets.findMany({ where: { whiteboardId: "whiteboard_1" } });
    expect(Object.fromEntries(rows.map((row) => [row.r2Key, row.status]))).toEqual({
      [key(1)]: "committed",
      [key(2)]: "committed",
      [key(3)]: "deleting",
      [key(4)]: "deleting",
      [key(1, otherImportId)]: "committed",
    });
  });
});

describe("retireWhiteboardAssets", () => {
  const importId = "cae07632-4d82-4de0-848f-501bd7586496";
  const key = (page: number) => buildWhiteboardPdfImportAssetKey("whiteboard_1", importId, page);

  it("sends unplaced pages into deletion, keeping placed and borrowed ones", async () => {
    await commitPdfImportAssets(getAppDb(), {
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      importId,
      pages: [1, 2, 3].map((page) => ({ r2Key: key(page), size: 10 })),
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
    });
    // Page 3 is named by a copy of the board, so it is not this board's to retire.
    const now = new Date("2026-07-22T00:01:00.000Z");
    await db.insert(whiteboards).values({
      id: "whiteboard_2",
      syncRoomId: "whiteboard_2",
      spaceId: "host_space",
      title: "Copy",
      status: "active",
      createdByUserId: "host",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(whiteboardAssetReferences).values({
      id: "asset_reference_page_3",
      whiteboardId: "whiteboard_2",
      sourceWhiteboardId: "whiteboard_1",
      r2Key: key(3),
      createdAt: now,
    });

    await retireWhiteboardAssets(getAppDb(), {
      whiteboardId: "whiteboard_1",
      r2Keys: [key(2), key(3)],
      now: new Date(Date.now() + 60_000),
    });

    const rows = await db.query.whiteboardAssets.findMany({ where: { whiteboardId: "whiteboard_1" } });
    expect(Object.fromEntries(rows.map((row) => [row.r2Key, row.status]))).toEqual({
      [key(1)]: "committed",
      [key(2)]: "deleting",
      [key(3)]: "committed",
    });
  });
});

describe("isWhiteboardAssetReferencedByRevision", () => {
  const KEY = "whiteboards/whiteboard_1/assets/asset_1.png";
  const OTHER_KEY = "whiteboards/whiteboard_1/assets/asset_2.png";

  async function seedRevision(input: {
    id: string;
    whiteboardId?: string;
    revisionNumber?: number;
    assetManifest: string | null;
  }) {
    await db.insert(whiteboardRevisions).values({
      id: input.id,
      whiteboardId: input.whiteboardId ?? "whiteboard_1",
      spaceId: "host_space",
      revisionNumber: input.revisionNumber ?? 1,
      kind: "meeting_end",
      snapshotR2Key: `whiteboards/${input.whiteboardId ?? "whiteboard_1"}/revisions/${input.id}.json`,
      assetManifest: input.assetManifest,
      snapshotSize: 10,
      createdAt: new Date("2026-07-22T00:00:00.000Z"),
    });
  }

  it("reports an asset a revision manifest still references", async () => {
    await seedRevision({ id: "revision_1", assetManifest: JSON.stringify([KEY, OTHER_KEY]) });

    expect(
      await isWhiteboardAssetReferencedByRevision(getAppDb(), {
        whiteboardId: "whiteboard_1",
        r2Key: KEY,
      }),
    ).toBe(true);
  });

  it("reports an unreferenced asset as collectable", async () => {
    await seedRevision({ id: "revision_1", assetManifest: JSON.stringify([OTHER_KEY]) });

    expect(
      await isWhiteboardAssetReferencedByRevision(getAppDb(), {
        whiteboardId: "whiteboard_1",
        r2Key: KEY,
      }),
    ).toBe(false);
  });

  it("treats a board with no revisions as unreferenced", async () => {
    expect(
      await isWhiteboardAssetReferencedByRevision(getAppDb(), {
        whiteboardId: "whiteboard_1",
        r2Key: KEY,
      }),
    ).toBe(false);
  });

  it("ignores revisions with no manifest recorded", async () => {
    await seedRevision({ id: "revision_1", assetManifest: null });

    expect(
      await isWhiteboardAssetReferencedByRevision(getAppDb(), {
        whiteboardId: "whiteboard_1",
        r2Key: KEY,
      }),
    ).toBe(false);
  });

  it("finds the key in any revision, not just the newest", async () => {
    await seedRevision({ id: "revision_1", revisionNumber: 1, assetManifest: JSON.stringify([KEY]) });
    await seedRevision({ id: "revision_2", revisionNumber: 2, assetManifest: JSON.stringify([OTHER_KEY]) });

    // The whole point: the live document no longer shows this image, but an
    // earlier immutable record does.
    expect(
      await isWhiteboardAssetReferencedByRevision(getAppDb(), {
        whiteboardId: "whiteboard_1",
        r2Key: KEY,
      }),
    ).toBe(true);
  });

  it("restores a deleting registry row when an immutable revision retains it", async () => {
    const now = new Date("2026-07-22T00:10:00.000Z");
    await createPendingWhiteboardAsset(getAppDb(), {
      id: "asset_1",
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Key: KEY,
      filename: "asset.png",
      mimeType: "image/png",
      size: 10,
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
      now: new Date(now.getTime() - 60_000),
    });
    await commitWhiteboardAsset(getAppDb(), {
      id: "asset_1",
      whiteboardId: "whiteboard_1",
      r2Key: KEY,
      size: 10,
      now: new Date(now.getTime() - 30_000),
    });
    await requestWhiteboardAssetDeletion(getAppDb(), {
      id: "asset_1",
      whiteboardId: "whiteboard_1",
      from: "committed",
      now,
    });
    await seedRevision({ id: "revision_1", assetManifest: JSON.stringify([KEY]) });
    let deleteCalls = 0;
    const env = {
      R2_BUCKET: {
        delete: async () => {
          deleteCalls += 1;
        },
      },
    } as unknown as Env;

    await cleanupWhiteboardAssetOperations(
      getAppDb(),
      env,
      new Date(now.getTime() + 1_000),
    );

    expect(deleteCalls).toBe(0);
    await expect(db.query.whiteboardAssets.findFirst({ where: { id: "asset_1" } }))
      .resolves.toMatchObject({ status: "committed", expiresAt: null });
  });

  it("refuses to pin an asset after it crosses the durable deletion boundary", async () => {
    const now = new Date("2026-07-22T00:10:00.000Z");
    await createPendingWhiteboardAsset(getAppDb(), {
      id: "asset_1",
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Key: KEY,
      filename: "asset.png",
      mimeType: "image/png",
      size: 10,
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
      now: new Date(now.getTime() - 60_000),
    });
    await commitWhiteboardAsset(getAppDb(), {
      id: "asset_1",
      whiteboardId: "whiteboard_1",
      r2Key: KEY,
      size: 10,
      now: new Date(now.getTime() - 30_000),
    });
    await requestWhiteboardAssetDeletion(getAppDb(), {
      id: "asset_1",
      whiteboardId: "whiteboard_1",
      from: "committed",
      now,
    });
    await seedRevision({ id: "revision_1", assetManifest: JSON.stringify([KEY]) });

    await expect(db.insert(whiteboardRevisionAssetReferences).values({
      revisionId: "revision_1",
      r2Key: KEY,
      createdAt: now,
    })).rejects.toBeDefined();
    await expect(db.select().from(whiteboardRevisionAssetReferences))
      .resolves.toEqual([]);
  });

  it("lets a copied board retain an asset after its source board is deleted", async () => {
    const now = new Date("2026-07-22T00:10:00.000Z");
    await createPendingWhiteboardAsset(getAppDb(), {
      id: "asset_source",
      whiteboardId: "whiteboard_1",
      spaceId: "host_space",
      r2Key: KEY,
      filename: "asset.png",
      mimeType: "image/png",
      size: 10,
      uploader: { uploadedByUserId: "host", guestAdmissionId: null },
      now: new Date(now.getTime() - 60_000),
    });
    await commitWhiteboardAsset(getAppDb(), {
      id: "asset_source",
      whiteboardId: "whiteboard_1",
      r2Key: KEY,
      size: 10,
      now: new Date(now.getTime() - 30_000),
    });
    await db.insert(whiteboards).values({
      id: "whiteboard_copy",
      syncRoomId: "whiteboard_copy",
      spaceId: "host_space",
      title: "Copy",
      status: "active",
      createdByUserId: "host",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(whiteboardAssetReferences).values({
      id: "asset_reference_copy",
      whiteboardId: "whiteboard_copy",
      sourceWhiteboardId: "whiteboard_1",
      r2Key: KEY,
      createdAt: now,
    });

    await db.delete(whiteboards).where(eq(whiteboards.id, "whiteboard_1"));
    await seedRevision({
      id: "revision_copy",
      whiteboardId: "whiteboard_copy",
      assetManifest: JSON.stringify([KEY]),
    });

    await expect(db.insert(whiteboardRevisionAssetReferences).values({
      revisionId: "revision_copy",
      r2Key: KEY,
      createdAt: now,
    })).resolves.toBeDefined();
  });

  it("does not let another board's revision retain this board's asset", async () => {
    await db.insert(whiteboards).values({
      id: "whiteboard_2",
      syncRoomId: "whiteboard_2",
      spaceId: "host_space",
      title: "Other",
      status: "active",
      createdByUserId: "host",
      createdAt: new Date("2026-07-22T00:00:00.000Z"),
      updatedAt: new Date("2026-07-22T00:00:00.000Z"),
    });
    await seedRevision({
      id: "revision_other",
      whiteboardId: "whiteboard_2",
      assetManifest: JSON.stringify([KEY]),
    });

    expect(
      await isWhiteboardAssetReferencedByRevision(getAppDb(), {
        whiteboardId: "whiteboard_1",
        r2Key: KEY,
      }),
    ).toBe(false);
  });
});

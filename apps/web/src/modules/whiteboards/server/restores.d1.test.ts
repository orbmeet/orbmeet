import { afterEach, describe, expect, it, vi } from "vitest";
import { users, whiteboardRevisions, whiteboards } from "@orbmeet/db/schema";
import { syncCommandFailure } from "@orbmeet/whiteboard-core/sync-commands";
import { createTestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import {
  emulatedSyncServer,
  installFakeSyncServer,
} from "@/test/fake-sync-server";
import { TEST_WHITEBOARD_D1_ENV } from "@/test/whiteboard-d1-env";
import { withInlineJobs } from "@/test/jobs";
import { cleanupQueuedR2Objects } from "@/modules/assets/server/r2-cleanup.server";
import { restoreWhiteboardFromRevision } from "./restores";

const BOARD = "whiteboard_1";
const SOURCE_KEY = `whiteboards/${BOARD}/revisions/rev_old.json`;
const LIVE = JSON.stringify({ documents: [{ state: { id: "page:live" } }] });
const OLD = JSON.stringify({ documents: [{ state: { id: "page:old" } }] });
const LATER = Date.now() + 60 * 60_000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seedBoard() {
  const db = await createTestDb();
  const now = new Date("2026-07-19T00:00:00.000Z");
  await db.insert(users).values({
    id: "user_host",
    name: "Host",
    email: "host@example.com",
    normalizedEmail: "host@example.com",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, "user_host", { now });
  await db.insert(whiteboards).values({
    id: BOARD,
    syncRoomId: BOARD,
    spaceId: "user_host_space",
    title: "Calculus",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(whiteboardRevisions).values({
    id: "rev_old",
    whiteboardId: BOARD,
    spaceId: "user_host_space",
    revisionNumber: 1,
    kind: "meeting_end",
    snapshotR2Key: SOURCE_KEY,
    snapshotSize: OLD.length,
    createdAt: now,
  });

  const objects = new Map([[SOURCE_KEY, OLD]]);
  const rooms = new Map([[BOARD, LIVE]]);
  const bucket = {
    async delete(key: string) {
      objects.delete(key);
    },
    async head(key: string) {
      const body = objects.get(key);
      return body === undefined ? null : { key, size: body.length, httpMetadata: { contentType: "image/png" } };
    },
  } as unknown as R2Bucket;
  const env = withInlineJobs({ ...TEST_WHITEBOARD_D1_ENV, R2_BUCKET: bucket }) as unknown as Env;
  return { db, env, objects, rooms, emulated: emulatedSyncServer(objects, rooms) };
}

function restore(db: Awaited<ReturnType<typeof seedBoard>>["db"], env: Env) {
  return restoreWhiteboardFromRevision(db, env, { whiteboardId: BOARD, revisionId: "rev_old", userId: "user_host" });
}

async function preRestoreRevisions(db: Awaited<ReturnType<typeof seedBoard>>["db"]) {
  return db.query.whiteboardRevisions.findMany({ where: { whiteboardId: BOARD, kind: "pre_restore" } });
}

describe("whiteboard restores", () => {
  it("restores the board and records the state it replaced in History", async () => {
    const { db, env, objects, rooms, emulated } = await seedBoard();
    installFakeSyncServer(emulated);

    const outcome = await restore(db, env);

    expect(rooms.get(BOARD)).toBe(OLD);
    expect((await preRestoreRevisions(db)).map((revision) => revision.id)).toEqual([outcome.restorePointRevisionId]);
    expect(objects.get(`whiteboards/${BOARD}/revisions/${outcome.restorePointRevisionId}.json`)).toBe(LIVE);
  });

  it("keeps a restored board's undo point when History cannot record it at first", async () => {
    const { db, env, objects, rooms, emulated } = await seedBoard();
    installFakeSyncServer(emulated);
    // The job opens its own database on the D1 binding: fail the binding's
    // first batch once the restore point exists, which is History's.
    const batch = env.DB.batch.bind(env.DB);
    let failed = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (!failed && [...objects.keys()].some((key) => key !== SOURCE_KEY)) {
        failed = true;
        throw new Error("D1 is down");
      }
      return batch(statements);
    });

    const outcome = await restore(db, env);

    expect(failed).toBe(true);
    expect(rooms.get(BOARD)).toBe(OLD);
    const restorePointKey = `whiteboards/${BOARD}/revisions/${outcome.restorePointRevisionId}.json`;
    const [revision] = await preRestoreRevisions(db);
    expect(revision).toMatchObject({ id: outcome.restorePointRevisionId, snapshotR2Key: restorePointKey });
  });

  it("keeps the restore point from the cleanup queue while History may still record it", async () => {
    const { db, env, objects, rooms, emulated } = await seedBoard();
    let swept = false;
    installFakeSyncServer({
      ...emulated,
      // History's first read of the restore point finds the sync server
      // down, and the cleanup queue runs an hour later, long past its grace,
      // before the retry records the entry.
      readSnapshot: async (request) => {
        if (swept) return emulated.readSnapshot(request);
        swept = true;
        await cleanupQueuedR2Objects(db, env.R2_BUCKET, new Date(Date.now() + 60 * 60_000));
        return syncCommandFailure("unavailable", "Sync server is restarting");
      },
    });

    const outcome = await restore(db, env);

    expect(swept).toBe(true);
    expect(rooms.get(BOARD)).toBe(OLD);
    const restorePointKey = `whiteboards/${BOARD}/revisions/${outcome.restorePointRevisionId}.json`;
    expect(objects.get(restorePointKey)).toBe(LIVE);
    const [revision] = await preRestoreRevisions(db);
    expect(revision).toMatchObject({ id: outcome.restorePointRevisionId, snapshotR2Key: restorePointKey });
  });

  it("records the restore point of a board whose asset list is large", async () => {
    const { db, env, rooms, emulated } = await seedBoard();
    const documents = Array.from({ length: 800 }, (_, index) => ({
      state: {
        typeName: "asset",
        id: `asset:${index}`,
        props: { src: `whiteboards/${BOARD}/assets/page-${String(index).padStart(4, "0")}-imported-from-pdf.png` },
      },
    }));
    rooms.set(BOARD, JSON.stringify({ documents }));
    installFakeSyncServer(emulated);

    const outcome = await restore(db, env);

    expect((await preRestoreRevisions(db)).map((revision) => revision.id)).toEqual([outcome.restorePointRevisionId]);
  });

  it("pins every asset of a restore point that references more than one statement can bind", async () => {
    const { db, env, objects, rooms, emulated } = await seedBoard();
    const assetKeys = Array.from({ length: 60 }, (_, index) =>
      `whiteboards/${BOARD}/assets/page-${String(index).padStart(4, "0")}-imported-from-pdf.png`);
    for (const key of assetKeys) objects.set(key, "png");
    rooms.set(BOARD, JSON.stringify({
      documents: assetKeys.map((src, index) => ({ state: { typeName: "asset", id: `asset:${index}`, props: { src } } })),
    }));
    installFakeSyncServer(emulated);

    const outcome = await restore(db, env);

    const [restorePoint] = await preRestoreRevisions(db);
    expect(restorePoint?.id).toBe(outcome.restorePointRevisionId);
    const pinned = await db.query.whiteboardRevisionAssetReferences.findMany({
      where: { revisionId: restorePoint.id },
      columns: { r2Key: true },
    });
    expect(pinned.map((row) => row.r2Key).sort()).toEqual(assetKeys);
  });

  it("joins the first run when an answer was lost, instead of restoring twice", async () => {
    const { db, env, emulated } = await seedBoard();
    let calls = 0;
    installFakeSyncServer({
      ...emulated,
      restore: async (request) => {
        calls += 1;
        const result = await emulated.restore(request);
        // The first run happened; its answer never arrived.
        return calls === 1 ? { ok: false, reason: "unavailable", message: "Timed out" } : result;
      },
    });

    const outcome = await restore(db, env);

    expect(calls).toBe(2);
    expect((await preRestoreRevisions(db)).map((revision) => revision.id)).toEqual([outcome.restorePointRevisionId]);
  });

  it("refuses a restore that never started before its deadline, leaving the board as it was", async () => {
    const { db, env, rooms, emulated } = await seedBoard();
    let calls = 0;
    installFakeSyncServer({
      ...emulated,
      restore: (request) => {
        calls += 1;
        if (calls < 3) return { ok: false, reason: "unavailable", message: "Unreachable" };
        // Reachable again, but only after the start window closed.
        vi.spyOn(Date, "now").mockReturnValue(LATER);
        return emulated.restore(request);
      },
    });

    await expect(restore(db, env)).rejects.toMatchObject({ code: "CONFLICT" });

    expect(rooms.get(BOARD)).toBe(LIVE);
    await expect(preRestoreRevisions(db)).resolves.toEqual([]);
  });
});

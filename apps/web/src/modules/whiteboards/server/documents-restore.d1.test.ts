import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedStatements } from "@/platform/database/db-batching";
import {
  whiteboardRevisions,
  whiteboards,
} from "@orbmeet/db/schema";

import { seedMeetingWhiteboard } from "@/test/fixtures";

import { restoreWhiteboardFromRevision } from "./restores";
import { withInlineJobs } from "@/test/jobs";

import {
  emulatedSyncServer,
  installFakeSyncServer,
} from "@/test/fake-sync-server";
import { TEST_WHITEBOARD_D1_ENV } from "@/test/whiteboard-d1-env";
import { seedMeeting, fakeR2, syncServer, syncEnv, rooms } from "@/test/documents-test-support";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Meeting Whiteboard documents: restoring", () => {
  it("freezes the live state as a pre_restore Snapshot before a restore", async () => {
    const { db, now } = await seedMeeting("ended");
    const live = JSON.stringify({ documents: [{ state: { id: "page:live" } }] });
    const archived = JSON.stringify({ documents: [{ state: { id: "page:archived" } }] });
    const r2 = fakeR2({
      "whiteboards/whiteboard_1/revisions/rev_old.json": archived,
    });
    rooms(r2).set("whiteboard_1", live);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      now,
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_old",
      whiteboardId: "whiteboard_1",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_1/revisions/rev_old.json",
      snapshotSize: archived.length,
      createdAt: now,
    });

    const { restorePointRevisionId } = await restoreWhiteboardFromRevision(db, withInlineJobs(syncEnv(r2)), {
      whiteboardId: "whiteboard_1",
      revisionId: "rev_old",
      userId: "user_host",
      now,
    });

    expect(restorePointRevisionId).toBeTruthy();
    const revision = await db.query.whiteboardRevisions.findFirst({
      where: { id: restorePointRevisionId! },
    });
    expect(revision).toMatchObject({
      kind: "pre_restore",
      whiteboardId: "whiteboard_1",
      // No Meeting produced it — a restore point is a document event, and the
      // History panel labels it from the kind rather than from a Meeting title.
      sourceMeetingId: null,
      createdByUserId: "user_host",
      revisionNumber: 2,
    });
    // The frozen body is what the room held; the room now holds the restore.
    expect(r2.objects.get(revision!.snapshotR2Key)).toBe(live);
    expect(rooms(r2).get("whiteboard_1")).toBe(archived);
  });

  it("rolls restore history forward after reaching the plan limit", async () => {
    const { db, now } = await seedMeeting("ended");
    const snapshot = JSON.stringify({ documents: [] });
    const live = JSON.stringify({ documents: [{ state: { id: "page:live" } }] });
    const stored = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `whiteboards/whiteboard_1/revisions/restore-${index + 1}.json`,
        snapshot,
      ]),
    );
    const r2 = fakeR2(stored);
    rooms(r2).set("whiteboard_1", live);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      now,
    });
    const restoreRevisions = Array.from({ length: 25 }, (_, index) => ({
      id: `rev_restore_${index + 1}`,
      whiteboardId: "whiteboard_1",
      spaceId: "user_host_space",
      revisionNumber: index + 1,
      kind: "pre_restore" as const,
      snapshotR2Key: `whiteboards/whiteboard_1/revisions/restore-${index + 1}.json`,
      snapshotSize: snapshot.length,
      createdAt: new Date(now.getTime() + index * 1_000),
    }));
    for (const insert of boundedStatements(restoreRevisions, (chunk) => db.insert(whiteboardRevisions).values(chunk))) {
      await insert;
    }

    const { restorePointRevisionId } = await restoreWhiteboardFromRevision(db, withInlineJobs(syncEnv(r2)), {
      whiteboardId: "whiteboard_1",
      revisionId: "rev_restore_25",
      userId: "user_host",
      now: new Date(now.getTime() + 30_000),
    });

    const revisions = await db.query.whiteboardRevisions.findMany({
      where: { whiteboardId: "whiteboard_1", kind: "pre_restore" },
    });
    expect(restorePointRevisionId).toBeTruthy();
    expect(revisions).toHaveLength(25);
    expect(revisions.some((revision) => revision.id === "rev_restore_1")).toBe(false);
    // The pruned Snapshot's object is the cleanup queue's to delete.
    await expect(db.query.r2ObjectCleanupTasks.findFirst({
      where: { r2Key: "whiteboards/whiteboard_1/revisions/restore-1.json" },
    })).resolves.toBeDefined();
  });

  it("restores in one sync command that stores what was live as the restore point", async () => {
    // The sync server quiesces the room, stores the replaced state at the
    // restore-point key and persists the restored generation itself; the
    // Worker asks it from the board's serial scope and records the rows.
    const { db, now } = await seedMeeting("ended");
    const live = JSON.stringify({ documents: [{ state: { id: "page:live" } }] });
    const archived = JSON.stringify({ documents: [{ state: { id: "page:archived" } }] });
    const r2 = fakeR2({
      "whiteboards/whiteboard_1/revisions/rev_old.json": archived,
    });
    rooms(r2).set("whiteboard_1", live);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      now,
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_old",
      whiteboardId: "whiteboard_1",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_1/revisions/rev_old.json",
      snapshotSize: archived.length,
      createdAt: now,
    });

    const { commands } = installFakeSyncServer(emulatedSyncServer(r2.objects, rooms(r2)));
    const env = { ...TEST_WHITEBOARD_D1_ENV, R2_BUCKET: r2.bucket } as unknown as Env;

    const result = await restoreWhiteboardFromRevision(db, withInlineJobs(env), {
      whiteboardId: "whiteboard_1",
      revisionId: "rev_old",
      userId: "user_host",
    });

    expect(commands).toEqual([
      {
        name: "restore",
        request: expect.objectContaining({
          whiteboardId: "whiteboard_1",
          sourceKey: "whiteboards/whiteboard_1/revisions/rev_old.json",
          restorePointKey: `whiteboards/whiteboard_1/revisions/${result.restorePointRevisionId}.json`,
        }),
      },
      // History reads the restore point back, asset keys included.
      {
        name: "readSnapshot",
        request: { key: `whiteboards/whiteboard_1/revisions/${result.restorePointRevisionId}.json` },
      },
    ]);
    const restorePoint = await db.query.whiteboardRevisions.findFirst({
      where: { id: result.restorePointRevisionId ?? "" },
      columns: { kind: true, snapshotR2Key: true },
    });
    expect(restorePoint?.kind).toBe("pre_restore");
    expect(r2.objects.get(restorePoint?.snapshotR2Key ?? "")).toBe(live);
    expect(rooms(r2).get("whiteboard_1")).toBe(archived);
  });

  it("rejoins a restore that outlasted the command timeout, keeping its restore point", async () => {
    // The first answer never arrives in time, but the sync server finishes the
    // restore anyway. Asking again with the same command id must return that
    // run's restore point, not report a board that is already restored.
    const { db, now } = await seedMeeting("ended");
    const live = JSON.stringify({ documents: [{ state: { id: "page:live" } }] });
    const archived = JSON.stringify({ documents: [{ state: { id: "page:archived" } }] });
    const r2 = fakeR2({
      "whiteboards/whiteboard_1/revisions/rev_old.json": archived,
    });
    rooms(r2).set("whiteboard_1", live);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      now,
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_old",
      whiteboardId: "whiteboard_1",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_1/revisions/rev_old.json",
      snapshotSize: archived.length,
      createdAt: now,
    });

    const emulated = emulatedSyncServer(r2.objects, rooms(r2));
    const runs = new Map<string, ReturnType<typeof emulated.restore>>();
    const { commands } = installFakeSyncServer({
      ...emulated,
      restore: async (request) => {
        const running = runs.get(request.commandId);
        if (running) return running;
        runs.set(request.commandId, emulated.restore(request));
        return { ok: false, reason: "unavailable", message: "Whiteboard service unavailable" };
      },
    });
    const env = { ...TEST_WHITEBOARD_D1_ENV, R2_BUCKET: r2.bucket } as unknown as Env;

    const result = await restoreWhiteboardFromRevision(db, withInlineJobs(env), {
      whiteboardId: "whiteboard_1",
      revisionId: "rev_old",
      userId: "user_host",
    });

    const restores = commands.filter((command) => command.name === "restore");
    expect(restores).toHaveLength(2);
    expect(restores[1].request).toEqual(restores[0].request);
    const restorePoint = await db.query.whiteboardRevisions.findFirst({
      where: { id: result.restorePointRevisionId ?? "" },
      columns: { kind: true, snapshotR2Key: true },
    });
    expect(restorePoint?.kind).toBe("pre_restore");
    expect(r2.objects.get(restorePoint?.snapshotR2Key ?? "")).toBe(live);
  });

  it("freezes the live room's state, every acknowledged edit included", async () => {
    // The restore point comes from the room itself: every acknowledged edit is
    // part of what the restore replaces, so it must be part of the way back.
    const { db, now } = await seedMeeting("ended");
    const live = JSON.stringify({ documents: [{ state: { id: "page:live" } }] });
    const archived = JSON.stringify({ documents: [{ state: { id: "page:archived" } }] });
    const r2 = fakeR2({
      "whiteboards/whiteboard_1/revisions/rev_old.json": archived,
    });
    rooms(r2).set("whiteboard_1", live);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      now,
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_old",
      whiteboardId: "whiteboard_1",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_1/revisions/rev_old.json",
      snapshotSize: archived.length,
      createdAt: now,
    });

    const server = syncServer(r2);
    server.rooms.set(
      "whiteboard_1",
      JSON.stringify({
        documents: [
          { state: { id: "page:live" } },
          { state: { id: "shape:acknowledged", typeName: "shape" } },
        ],
      }),
    );

    const { restorePointRevisionId } = await restoreWhiteboardFromRevision(db, withInlineJobs(server.env), {
      whiteboardId: "whiteboard_1",
      revisionId: "rev_old",
      userId: "user_host",
    });

    const restorePoint = await db.query.whiteboardRevisions.findFirst({
      where: { id: restorePointRevisionId ?? "" },
      columns: { snapshotR2Key: true },
    });
    expect(r2.objects.get(restorePoint?.snapshotR2Key ?? "")).toContain("shape:acknowledged");
    expect(server.rooms.get("whiteboard_1")).toBe(archived);
  });

  it("leaves no trace when the sync server refuses a restore", async () => {
    const { db, now } = await seedMeeting("ended");
    const live = JSON.stringify({ documents: [{ state: { id: "page:live" } }] });
    const archived = JSON.stringify({ documents: [{ state: { id: "page:archived" } }] });
    const r2 = fakeR2({
      "whiteboards/whiteboard_1/revisions/rev_old.json": archived,
    });
    rooms(r2).set("whiteboard_1", live);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      now,
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_old",
      whiteboardId: "whiteboard_1",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_1/revisions/rev_old.json",
      snapshotSize: archived.length,
      createdAt: now,
    });

    installFakeSyncServer({
      restore: () => ({ ok: false, reason: "unavailable", message: "The restore could not be saved" }),
    });
    const env = { ...TEST_WHITEBOARD_D1_ENV, R2_BUCKET: r2.bucket } as unknown as Env;

    await expect(restoreWhiteboardFromRevision(db, withInlineJobs(env), {
      whiteboardId: "whiteboard_1",
      revisionId: "rev_old",
      userId: "user_host",
    })).rejects.toMatchObject({ statusCode: 503 });

    expect(await db.select().from(whiteboardRevisions)).toHaveLength(1);
  });

  it("treats a retry as complete when the target document content is already live", async () => {
    const { db, now } = await seedMeeting("ended");
    const state = { id: "page:same", typeName: "page", name: "Restored" };
    const live = JSON.stringify({
      documentClock: 99,
      documents: [{ lastChangedClock: 99, state }],
    });
    const archived = JSON.stringify({
      documentClock: 4,
      documents: [{ state: { name: "Restored", typeName: "page", id: "page:same" }, lastChangedClock: 4 }],
    });
    const r2 = fakeR2({
      "whiteboards/whiteboard_1/revisions/rev_old.json": archived,
    });
    rooms(r2).set("whiteboard_1", live);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      now,
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_old",
      whiteboardId: "whiteboard_1",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_1/revisions/rev_old.json",
      snapshotSize: archived.length,
      createdAt: now,
    });
    await expect(restoreWhiteboardFromRevision(db, withInlineJobs(syncEnv(r2)), {
      whiteboardId: "whiteboard_1",
      revisionId: "rev_old",
      userId: "user_host",
    })).resolves.toEqual({ restorePointRevisionId: null });

    expect(await db.select().from(whiteboardRevisions)).toHaveLength(1);
  });

  it("will not restore another board's Snapshot onto this one", async () => {
    // A revision id would otherwise be a key to any board's history: read one
    // and you could paste that class's work onto a board you do own.
    const { db, now } = await seedMeeting("ended");
    const snapshot = JSON.stringify({ documents: [] });
    const r2 = fakeR2({ "other.json": snapshot });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      now,
    });
    await db.insert(whiteboards).values({
      id: "whiteboard_other",
      syncRoomId: "whiteboard_other",
      spaceId: "user_host_space",
      title: "Someone else's",
      status: "active",
      createdByUserId: "user_host",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_other",
      whiteboardId: "whiteboard_other",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_other/revisions/rev_other.json",
      snapshotSize: snapshot.length,
      createdAt: now,
    });

    const { commands } = syncServer(r2);
    await expect(restoreWhiteboardFromRevision(db, withInlineJobs(syncEnv(r2)), {
      whiteboardId: "whiteboard_1",
      revisionId: "rev_other",
      userId: "user_host",
    })).rejects.toThrow();

    expect(commands).toEqual([]);
    // And nothing was frozen either: a rejected restore leaves no trace.
    expect(await db.select().from(whiteboardRevisions)).toHaveLength(1);
  });

  it("restores onto a Whiteboard nobody has drawn on yet", async () => {
    // Restoring onto a blank board is legitimate. Its empty state is frozen
    // like any other, so even this restore can be undone.
    const { db, now } = await seedMeeting();
    const archived = JSON.stringify({ documents: [{ state: { id: "page:archived" } }] });
    const r2 = fakeR2({ "whiteboards/whiteboard_blank/revisions/rev_old.json": archived });
    await db.insert(whiteboards).values({
      id: "whiteboard_blank",
      syncRoomId: "whiteboard_blank",
      spaceId: "user_host_space",
      title: "Prepared last night",
      status: "active",
      createdByUserId: "user_host",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_old",
      whiteboardId: "whiteboard_blank",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_blank/revisions/rev_old.json",
      snapshotSize: archived.length,
      createdAt: now,
    });

    const { restorePointRevisionId } = await restoreWhiteboardFromRevision(db, withInlineJobs(syncEnv(r2)), {
      whiteboardId: "whiteboard_blank",
      revisionId: "rev_old",
      userId: "user_host",
      now,
    });

    expect(restorePointRevisionId).toBeTruthy();
    expect(rooms(r2).get("whiteboard_blank")).toBe(archived);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  meetings,
  meetingWhiteboards,
  r2ObjectCleanupTasks,
  whiteboardRevisions,
} from "@orbmeet/db/schema";
import { internalMeetingWhiteboardCaptureKey } from "@orbmeet/whiteboard-core/document-keys";

import { eq } from "drizzle-orm";

import { seedMeetingWhiteboard } from "@/test/fixtures";

import {
  pinMeetingWhiteboardSharedState,
  captureMeetingWhiteboardUsageRevision,
} from "./document-revisions";
import { restoreWhiteboardFromRevision } from "./restores";
import { withInlineJobs } from "@/test/jobs";
import { cleanupQueuedR2Objects } from "@/modules/assets/server/r2-cleanup.server";

import {
  fakeSnapshotHash,
} from "@/test/fake-sync-server";
import { seedMeeting, fakeR2, syncEnv, rooms, inTime, captureMeetingWhiteboardRevision } from "@/test/documents-test-support";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Meeting Whiteboard documents: capturing what a Meeting shared", () => {
  it("pins a separate Snapshot for every Whiteboard one Meeting presented", async () => {
    // The exclusivity index is gone, so a Meeting may present several boards.
    // Each is a document in its own right and gets its own frozen record of
    // what the class saw; there is nothing to serialize between them.
    const { db, now } = await seedMeeting("ended");
    const snapshot = JSON.stringify({ documents: [] });
    const r2 = fakeR2({
      "internal/meetings/meeting_1/canvases/whiteboard_a/boundary.json": snapshot,
      "internal/meetings/meeting_1/canvases/whiteboard_b/boundary.json": snapshot,
    });
    for (const [id, title, focused] of [
      ["whiteboard_a", "Algebra", true],
      // Presented earlier in the same Meeting and since switched away from.
      // Still shown, still captured — focus is what the room is looking at
      // right now, not what counts as having been presented.
      ["whiteboard_b", "Geometry", false],
    ] as const) {
      await seedMeetingWhiteboard(db, {
        whiteboardId: id,
        meetingWhiteboardId: `usage_${id}`,
        meetingId: "meeting_1",
        spaceId: "user_host_space",
        title,
        focused,
        lastSharedSnapshotR2Key:
          `internal/meetings/meeting_1/canvases/${id}/boundary.json`,
        lastSharedSnapshotSize: snapshot.length,
        now,
      });
    }

    await captureMeetingWhiteboardRevision(
      db,
      syncEnv(r2),
      "meeting_1",
      new Date(now.getTime() + 1_000),
    );

    const revisions = await db.select().from(whiteboardRevisions);
    expect(revisions).toHaveLength(2);
    expect(revisions.map((revision) => revision.whiteboardId).sort())
      .toEqual(["whiteboard_a", "whiteboard_b"]);
    // Each Snapshot records the name its board carried at the end, so a later
    // rename cannot rewrite what this Meeting's page says was shown.
    const usages = await db.query.meetingWhiteboards.findMany({
      where: { meetingId: "meeting_1" },
      columns: { whiteboardId: true, titleAtEnd: true, captureStatus: true },
    });
    expect(usages.every((usage) => usage.captureStatus === "captured")).toBe(true);
    expect(usages.map((usage) => usage.titleAtEnd).sort()).toEqual(["Algebra", "Geometry"]);
  });

  it("pins one immutable final revision when the Meeting ends", async () => {
    const { db, now } = await seedMeeting("ended");
    const snapshot = JSON.stringify({ documents: [] });
    const r2 = fakeR2({
      "internal/meetings/meeting_1/canvases/whiteboard_1/boundary.json": snapshot,
    });
    rooms(r2).set("whiteboard_1", snapshot);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Product review",
      lastSharedSnapshotR2Key:
        "internal/meetings/meeting_1/canvases/whiteboard_1/boundary.json",
      lastSharedSnapshotSize: snapshot.length,
      now,
    });

    const revisionId = await captureMeetingWhiteboardRevision(
      db,
      syncEnv(r2),
      "meeting_1",
      new Date(now.getTime() + 1_000),
    );

    expect(revisionId).toBeTruthy();
    expect(await db.select().from(whiteboardRevisions)).toHaveLength(1);
    await expect(db.query.meetingWhiteboards.findFirst({
      where: { meetingId: "meeting_1", whiteboardId: "whiteboard_1" },
      columns: { captureStatus: true, capturedAt: true },
    })).resolves.toMatchObject({ captureStatus: "captured", capturedAt: expect.any(Date) });
    expect(await captureMeetingWhiteboardRevision(
      db,
      syncEnv(r2),
      "meeting_1",
    )).toBe(revisionId);
  });

  it("freezes the last shared state instead of later private edits", async () => {
    const { db, now } = await seedMeeting("open");
    const sharedSnapshot = JSON.stringify({ documents: [{ id: "shared" }] });
    const privateSnapshot = JSON.stringify({ documents: [{ id: "private" }] });
    const r2 = fakeR2();
    rooms(r2).set("whiteboard_1", sharedSnapshot);
    const seeded = await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "IMO2026",
      now,
    });

    await pinMeetingWhiteboardSharedState(
      db,
      syncEnv(r2),
      { meetingId: "meeting_1", usageId: seeded.meetingWhiteboardId, commandId: "wbpin-1-usage", startBefore: inTime() },
      new Date(now.getTime() + 1_000),
    );
    await db.update(meetings).set({
      status: "ended",
      endedAt: new Date(now.getTime() + 1_500),
      updatedAt: new Date(now.getTime() + 1_500),
    }).where(eq(meetings.id, "meeting_1"));
    // The living Whiteboard changes after it leaves the shared surface.
    rooms(r2).set("whiteboard_1", privateSnapshot);

    const revisionId = await captureMeetingWhiteboardUsageRevision(
      db,
      syncEnv(r2),
      seeded.meetingWhiteboardId,
      new Date(now.getTime() + 2_000),
    );
    const revision = await db.query.whiteboardRevisions.findFirst({
      where: { id: revisionId! },
      columns: { snapshotR2Key: true },
    });
    expect(r2.objects.get(revision!.snapshotR2Key)).toBe(sharedSnapshot);
  });

  it("pins after the Meeting ended, and never moves a pin back in document time", async () => {
    // The room pins at each boundary and keeps retrying through an outage, so
    // a pin can land after the end, and after a later one.
    const { db, now } = await seedMeeting("ended");
    const shared = JSON.stringify({ documents: [{ id: "shared" }] });
    const r2 = fakeR2();
    rooms(r2).set("whiteboard_1", shared);
    const seeded = await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "IMO2026",
      now,
    });
    const env = syncEnv(r2);
    const pinOf = async () => (await db.query.meetingWhiteboards.findFirst({
      where: { id: seeded.meetingWhiteboardId },
      columns: { lastSharedSnapshotR2Key: true, lastSharedDocumentClock: true },
    }))!;

    await pinMeetingWhiteboardSharedState(db, env, {
      meetingId: "meeting_1", usageId: seeded.meetingWhiteboardId, commandId: "wbpin-3-usage", startBefore: inTime(),
    });
    const pinned = await pinOf();
    expect(pinned.lastSharedSnapshotR2Key).toContain("wbpin-3-usage");

    // A pin recorded at a later document time than the one landing now wins.
    await db.update(meetingWhiteboards)
      .set({ lastSharedDocumentClock: 1_000_000 })
      .where(eq(meetingWhiteboards.id, seeded.meetingWhiteboardId));
    await pinMeetingWhiteboardSharedState(db, env, {
      meetingId: "meeting_1", usageId: seeded.meetingWhiteboardId, commandId: "wbpin-2-usage", startBefore: inTime(),
    });
    expect((await pinOf()).lastSharedSnapshotR2Key).toBe(pinned.lastSharedSnapshotR2Key);
  });

  it("never moves the slot to a capture the cleanup queue is deleting", async () => {
    const { db, now } = await seedMeeting("open");
    const r2 = fakeR2();
    rooms(r2).set("whiteboard_1", JSON.stringify({ documents: [{ id: "shared" }] }));
    const seeded = await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "IMO2026",
      now,
    });
    // The pin ran too late: the queue found its capture unreferenced and is
    // deleting it by the time the slot update arrives.
    await db.insert(r2ObjectCleanupTasks).values({
      r2Key: internalMeetingWhiteboardCaptureKey("meeting_1", "whiteboard_1", "wbpin-1-usage"),
      notBefore: now,
      deletingAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await pinMeetingWhiteboardSharedState(db, syncEnv(r2), {
      meetingId: "meeting_1", usageId: seeded.meetingWhiteboardId, commandId: "wbpin-1-usage", startBefore: inTime(),
    });

    const usage = await db.query.meetingWhiteboards.findFirst({
      where: { id: seeded.meetingWhiteboardId },
      columns: { lastSharedSnapshotR2Key: true },
    });
    expect(usage?.lastSharedSnapshotR2Key).toBeNull();
  });

  it("never pins a boundary whose pin could not start in time (WB-04)", async () => {
    const { db, now } = await seedMeeting("open");
    const shared = JSON.stringify({ documents: [{ id: "shared" }] });
    const privateEdit = JSON.stringify({ documents: [{ id: "private" }] });
    const r2 = fakeR2();
    rooms(r2).set("whiteboard_1", shared);
    const seeded = await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "IMO2026",
      now,
    });
    const env = syncEnv(r2);
    await pinMeetingWhiteboardSharedState(db, env, {
      meetingId: "meeting_1", usageId: seeded.meetingWhiteboardId, commandId: "wbpin-1-usage", startBefore: inTime(),
    });
    await db.update(meetings).set({ status: "ended", endedAt: now, updatedAt: now })
      .where(eq(meetings.id, "meeting_1"));
    // The board is edited privately while the next boundary's pin waits out
    // an outage, and the pin only reaches the sync server past its window.
    rooms(r2).set("whiteboard_1", privateEdit);
    await pinMeetingWhiteboardSharedState(db, env, {
      meetingId: "meeting_1", usageId: seeded.meetingWhiteboardId, commandId: "wbpin-2-usage", startBefore: Date.now() - 1,
    });

    const usage = await db.query.meetingWhiteboards.findFirst({
      where: { id: seeded.meetingWhiteboardId },
      columns: { lastSharedSnapshotR2Key: true },
    });
    expect(usage?.lastSharedSnapshotR2Key).toContain("wbpin-1-usage");
    const revisionId = await captureMeetingWhiteboardUsageRevision(db, env, seeded.meetingWhiteboardId);
    const revision = await db.query.whiteboardRevisions.findFirst({
      where: { id: revisionId! },
      columns: { snapshotR2Key: true },
    });
    expect(r2.objects.get(revision!.snapshotR2Key)).toBe(shared);
  });

  it("captures what was shared, not the board's latest revision (WB-05)", async () => {
    const { db, now } = await seedMeeting("open");
    const oldLesson = JSON.stringify({ documents: [{ id: "old-lesson" }] });
    const prepared = JSON.stringify({ documents: [{ id: "prepared-lesson" }] });
    const r2 = fakeR2({
      "whiteboards/whiteboard_1/revisions/rev_old.json": oldLesson,
    });
    rooms(r2).set("whiteboard_1", prepared);
    const seeded = await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Lesson",
      now,
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_old",
      whiteboardId: "whiteboard_1",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_1/revisions/rev_old.json",
      snapshotHash: fakeSnapshotHash("old-lesson"),
      snapshotSize: oldLesson.length,
      createdAt: now,
    });
    const env = syncEnv(r2);
    await pinMeetingWhiteboardSharedState(db, env, {
      meetingId: "meeting_1", usageId: seeded.meetingWhiteboardId, commandId: "wbpin-1-usage", startBefore: inTime(),
    });
    await db.update(meetings).set({ status: "ended", endedAt: now, updatedAt: now })
      .where(eq(meetings.id, "meeting_1"));

    const revisionId = await captureMeetingWhiteboardUsageRevision(db, env, seeded.meetingWhiteboardId);

    expect(revisionId).not.toBe("rev_old");
    const revision = await db.query.whiteboardRevisions.findFirst({
      where: { id: revisionId! },
      columns: { snapshotR2Key: true },
    });
    expect(r2.objects.get(revision!.snapshotR2Key)).toBe(prepared);
  });

  it("reuses a revision that holds exactly the shared bytes", async () => {
    const { db, now } = await seedMeeting("open");
    const lesson = JSON.stringify({ documents: [{ id: "lesson" }] });
    const r2 = fakeR2({ "whiteboards/whiteboard_1/revisions/rev_same.json": lesson });
    rooms(r2).set("whiteboard_1", lesson);
    const seeded = await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Lesson",
      now,
    });
    const env = syncEnv(r2);
    await pinMeetingWhiteboardSharedState(db, env, {
      meetingId: "meeting_1", usageId: seeded.meetingWhiteboardId, commandId: "wbpin-1-usage", startBefore: inTime(),
    });
    const pinned = await db.query.meetingWhiteboards.findFirst({
      where: { id: seeded.meetingWhiteboardId },
      columns: { lastSharedSnapshotR2Key: true, lastSharedSnapshotHash: true },
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_same",
      whiteboardId: "whiteboard_1",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: "whiteboards/whiteboard_1/revisions/rev_same.json",
      snapshotHash: pinned!.lastSharedSnapshotHash,
      snapshotSize: lesson.length,
      createdAt: now,
    });
    // Owed to the cleanup queue since its pin, but held by the unsettled slot.
    await cleanupQueuedR2Objects(db, r2.bucket, new Date(Date.now() + 60 * 60_000));
    expect(r2.objects.has(pinned!.lastSharedSnapshotR2Key!)).toBe(true);
    await db.update(meetings).set({ status: "ended", endedAt: now, updatedAt: now })
      .where(eq(meetings.id, "meeting_1"));

    await expect(captureMeetingWhiteboardUsageRevision(db, env, seeded.meetingWhiteboardId))
      .resolves.toBe("rev_same");
    expect(await db.select().from(whiteboardRevisions)).toHaveLength(1);
    // The slot's capture is garbage once the usage is settled: the cleanup
    // queue deletes it after its grace.
    await cleanupQueuedR2Objects(db, r2.bucket, new Date(Date.now() + 60 * 60_000));
    expect(r2.objects.has(pinned!.lastSharedSnapshotR2Key!)).toBe(false);
  });

  it("shares one revision number sequence between restore points and Meetings", async () => {
    // Both kinds are rows in the same per-board sequence, and the unique index
    // on (whiteboard_id, revision_number) is what enforces it. A restore point
    // that restarted numbering would collide with the next Meeting's capture.
    const { db, now } = await seedMeeting("ended");
    const snapshot = JSON.stringify({ documents: [] });
    const live = JSON.stringify({ documents: [{ state: { id: "page:live" } }] });
    const r2 = fakeR2({
      "internal/meetings/meeting_1/canvases/whiteboard_1/boundary.json": snapshot,
    });
    rooms(r2).set("whiteboard_1", live);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      lastSharedSnapshotR2Key:
        "internal/meetings/meeting_1/canvases/whiteboard_1/boundary.json",
      lastSharedSnapshotSize: snapshot.length,
      now,
    });

    const capturedRevisionId = await captureMeetingWhiteboardRevision(
      db,
      syncEnv(r2),
      "meeting_1",
      new Date(now.getTime() + 1_000),
    );
    await restoreWhiteboardFromRevision(db, withInlineJobs(syncEnv(r2)), {
      whiteboardId: "whiteboard_1",
      revisionId: capturedRevisionId!,
      userId: "user_host",
      now: new Date(now.getTime() + 2_000),
    });

    const revisions = await db.select().from(whiteboardRevisions);
    expect(revisions.map((revision) => revision.revisionNumber).sort()).toEqual([1, 2]);
    expect(
      revisions.find((revision) => revision.kind === "pre_restore")?.revisionNumber,
    ).toBe(2);
  });

  it("allocates concurrent restore-point and capture revision numbers inside the write", async () => {
    const { db, now } = await seedMeeting("ended");
    const snapshot = JSON.stringify({ documents: [] });
    const live = JSON.stringify({ documents: [{ state: { id: "page:live" } }] });
    const archived = JSON.stringify({ documents: [{ state: { id: "page:archived" } }] });
    const r2 = fakeR2({
      "internal/meetings/meeting_1/canvases/whiteboard_1/boundary.json": snapshot,
      "whiteboards/whiteboard_1/revisions/rev_old.json": archived,
    });
    rooms(r2).set("whiteboard_1", live);
    const usage = await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      lastSharedSnapshotR2Key:
        "internal/meetings/meeting_1/canvases/whiteboard_1/boundary.json",
      lastSharedSnapshotSize: snapshot.length,
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

    const [captured, restored] = await Promise.all([
      captureMeetingWhiteboardUsageRevision(db, syncEnv(r2), usage.meetingWhiteboardId, now),
      restoreWhiteboardFromRevision(db, withInlineJobs(syncEnv(r2)), {
        whiteboardId: "whiteboard_1",
        revisionId: "rev_old",
        userId: "user_host",
        now,
      }),
    ]);

    expect(captured).not.toBe(restored.restorePointRevisionId);
    const revisions = await db.select().from(whiteboardRevisions);
    expect(revisions.map((revision) => revision.revisionNumber).sort()).toEqual([1, 2, 3]);
  });

  it("converges concurrent Meeting captures on one committed revision", async () => {
    const { db, now } = await seedMeeting("ended");
    const snapshot = JSON.stringify({ documents: [] });
    const r2 = fakeR2({
      "internal/meetings/meeting_1/canvases/whiteboard_1/boundary.json": snapshot,
    });
    rooms(r2).set("whiteboard_1", snapshot);
    const usage = await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      lastSharedSnapshotR2Key:
        "internal/meetings/meeting_1/canvases/whiteboard_1/boundary.json",
      lastSharedSnapshotSize: snapshot.length,
      now,
    });

    const revisionIds = await Promise.all([
      captureMeetingWhiteboardUsageRevision(
        db,
        syncEnv(r2),
        usage.meetingWhiteboardId,
        now,
      ),
      captureMeetingWhiteboardUsageRevision(
        db,
        syncEnv(r2),
        usage.meetingWhiteboardId,
        now,
      ),
    ]);

    expect(revisionIds[0]).toBe(revisionIds[1]);
    await expect(db.select().from(whiteboardRevisions)).resolves.toHaveLength(1);
    await expect(db.query.meetingWhiteboards.findFirst({
      where: { id: usage.meetingWhiteboardId },
    })).resolves.toMatchObject({
      captureStatus: "captured",
      capturedRevisionId: revisionIds[0],
    });
  });

  it("keeps the committed revision object when D1 loses the batch response", async () => {
    const { db, now } = await seedMeeting("ended");
    const snapshot = JSON.stringify({ documents: [] });
    const boundaryKey =
      "internal/meetings/meeting_1/canvases/whiteboard_1/boundary.json";
    const r2 = fakeR2({
      [boundaryKey]: snapshot,
    });
    rooms(r2).set("whiteboard_1", snapshot);
    const usage = await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      lastSharedSnapshotR2Key: boundaryKey,
      lastSharedSnapshotSize: snapshot.length,
      now,
    });
    const committedBatch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (queries) => {
      await committedBatch(queries);
      throw new Error("network connection lost after commit");
    });

    const revisionId = await captureMeetingWhiteboardUsageRevision(
      db,
      syncEnv(r2),
      usage.meetingWhiteboardId,
      now,
    );
    const revision = await db.query.whiteboardRevisions.findFirst({
      where: { id: revisionId ?? "" },
      columns: { snapshotR2Key: true },
    });

    expect(revisionId).not.toBeNull();
    expect(revision?.snapshotR2Key).toBeTruthy();
    expect(r2.objects.has(revision?.snapshotR2Key ?? "")).toBe(true);
    // As on the happy path, the captured state the revision copied is
    // garbage, and the revision's own copy is kept.
    await cleanupQueuedR2Objects(db, r2.bucket, new Date(now.getTime() + 60 * 60_000));
    expect(r2.objects.has(boundaryKey)).toBe(false);
    expect(r2.objects.has(revision?.snapshotR2Key ?? "")).toBe(true);
  });
});

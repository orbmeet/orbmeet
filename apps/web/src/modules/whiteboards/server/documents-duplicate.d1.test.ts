import { afterEach, describe, expect, it, vi } from "vitest";

import {
  meetingWhiteboards,
  r2ObjectCleanupTasks,
  whiteboardAssets,
  whiteboardRevisions,
  whiteboards,
} from "@orbmeet/db/schema";

import { seedMeetingWhiteboard } from "@/test/fixtures";

import {
  copyWhiteboard, duplicateWhiteboard,
} from "./document-revisions";


import { seedMeeting, fakeR2, syncEnv, rooms } from "@/test/documents-test-support";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Meeting Whiteboard documents: duplicating", () => {
  it("duplicates a Whiteboard from its current state, with no Meeting involved", async () => {
    const { db, now } = await seedMeeting("ended");
    const snapshot = JSON.stringify({ documents: [
      { state: { id: "shape:page", typeName: "shape", type: "whiteboard-page" } },
    ] });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_source",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Yesterday",
      now,
    });
    const r2 = fakeR2();
    rooms(r2).set("whiteboard_source", snapshot);

    const copy = await duplicateWhiteboard(syncEnv(r2), {
      whiteboardId: "whiteboard_source",
      userId: "user_host",
    });

    expect(copy.whiteboardId).not.toBe("whiteboard_source");
    expect(copy.title).toBe("Copy of Yesterday");
    expect(rooms(r2).get(copy.whiteboardId)).toBe(snapshot);
    // A copy is a document, not a presentation: nothing was attached anywhere.
    expect(await db.select().from(meetingWhiteboards)).toHaveLength(1);
  });

  it("duplicates embedded assets by reference instead of copying R2 bytes", async () => {
    const { db, now } = await seedMeeting("ended");
    const assetKey = "whiteboards/whiteboard_source/assets/page-1.png";
    const snapshot = JSON.stringify({
      documents: [{
        state: {
          id: "asset:pdf-page",
          typeName: "asset",
          props: { src: `/api/wb-assets/${assetKey}` },
        },
      }],
    });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_source",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      now,
    });
    // The embedded page was placed through the ordinary commit path, so the
    // source board's registry proves the bytes committed — the copy-reference
    // trigger requires that proof.
    await db.insert(whiteboardAssets).values({
      id: "asset_page_1",
      whiteboardId: "whiteboard_source",
      spaceId: "user_host_space",
      r2Key: assetKey,
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
    const r2 = fakeR2({ [assetKey]: "image-bytes" });
    rooms(r2).set("whiteboard_source", snapshot);

    const copy = await duplicateWhiteboard(syncEnv(r2), {
      whiteboardId: "whiteboard_source",
      userId: "user_host",
    });

    expect([...r2.objects.keys()].filter((key) => key.includes("/assets/")))
      .toEqual([assetKey]);
    await expect(db.query.whiteboardAssetReferences.findFirst({
      where: { whiteboardId: copy.whiteboardId, r2Key: assetKey },
      columns: { sourceWhiteboardId: true },
    })).resolves.toEqual({ sourceWhiteboardId: "whiteboard_source" });

    const secondCopy = await duplicateWhiteboard(syncEnv(r2), {
      whiteboardId: copy.whiteboardId,
      userId: "user_host",
    });
    await expect(db.query.whiteboardAssetReferences.findFirst({
      where: { whiteboardId: secondCopy.whiteboardId, r2Key: assetKey },
      columns: { sourceWhiteboardId: true },
    })).resolves.toEqual({ sourceWhiteboardId: "whiteboard_source" });
  });

  it("never leaves a copy without the references that authorize its assets", async () => {
    const { db, now } = await seedMeeting("ended");
    const assetKey = "whiteboards/whiteboard_source/assets/page-1.png";
    const snapshot = JSON.stringify({
      documents: [{
        state: {
          id: "asset:pdf-page",
          typeName: "asset",
          props: { src: `/api/wb-assets/${assetKey}` },
        },
      }],
    });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_source",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      now,
    });
    // No committed-asset proof for the page: the copy-reference trigger
    // refuses the reference rows. And the rollback's own delete fails too,
    // as it does when D1 is having the incident that failed the write.
    const r2 = fakeR2({ [assetKey]: "image-bytes" });
    rooms(r2).set("whiteboard_source", snapshot);
    const failingDeletes = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "delete") return () => { throw new Error("D1 unavailable"); };
        return Reflect.get(target, prop, receiver);
      },
    });
    const boardsBefore = await db.$count(whiteboards);

    await expect(copyWhiteboard(failingDeletes, syncEnv(r2), {
      whiteboardId: "whiteboard_source",
      userId: "user_host",
    })).rejects.toThrow();

    // The board and its references commit together: with the references
    // refused, there is no board left holding the copy without them.
    expect(await db.$count(whiteboards)).toBe(boardsBefore);
  });

  it("refuses to duplicate a revision whose stored state cannot be read", async () => {
    // Copying bytes is not copying a document: an unreadable source produced a
    // board in the Space list that opens to nothing, indistinguishable from a
    // bug in the copy itself.
    const { db, now } = await seedMeeting("ended");
    const revisionKey = "whiteboards/whiteboard_source/revisions/rev_bad.json";
    const truncated = '{"documents":[{"state":{"id":"shape:a"';
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_source",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      now,
    });
    await db.insert(whiteboardRevisions).values({
      id: "rev_bad",
      whiteboardId: "whiteboard_source",
      spaceId: "user_host_space",
      revisionNumber: 1,
      kind: "meeting_end",
      snapshotR2Key: revisionKey,
      snapshotSize: truncated.length,
      createdAt: now,
    });
    const r2 = fakeR2({ [revisionKey]: truncated });

    await expect(duplicateWhiteboard(syncEnv(r2), {
      whiteboardId: "whiteboard_source",
      revisionId: "rev_bad",
      userId: "user_host",
    })).rejects.toThrow("cannot be read");
    await expect(db.query.whiteboards.findMany({ columns: { id: true } }))
      .resolves.toEqual([{ id: "whiteboard_source" }]);
  });

  it("refuses to publish references when a source asset was already deleted", async () => {
    const { db, now } = await seedMeeting("ended");
    const assetKey = "whiteboards/whiteboard_source/assets/missing.png";
    const snapshot = JSON.stringify({
      documents: [{
        state: {
          id: "asset:image",
          typeName: "asset",
          props: { src: `/api/wb-assets/${assetKey}` },
        },
      }],
    });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_source",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      now,
    });
    const r2 = fakeR2();
    rooms(r2).set("whiteboard_source", snapshot);

    await expect(duplicateWhiteboard(syncEnv(r2), {
      whiteboardId: "whiteboard_source",
      userId: "user_host",
    })).rejects.toThrow("assets changed");
    await expect(db.query.whiteboardAssetReferences.findFirst({ where: { r2Key: assetKey } }))
      .resolves.toBeUndefined();
  });

  it("refuses to reference an asset the cleanup queue is deleting", async () => {
    const { db, now } = await seedMeeting("ended");
    const assetKey = "whiteboards/whiteboard_source/assets/image.png";
    const snapshot = JSON.stringify({
      documents: [{
        state: {
          id: "asset:image",
          typeName: "asset",
          props: { src: `/api/wb-assets/${assetKey}` },
        },
      }],
    });
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_source",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      now,
    });
    await db.insert(whiteboardAssets).values({
      id: "asset_image",
      whiteboardId: "whiteboard_source",
      spaceId: "user_host_space",
      r2Key: assetKey,
      filename: "image.png",
      mimeType: "image/png",
      size: 11,
      status: "committed",
      committedAt: now,
      createdAt: now,
    });
    // The queue has found the key unreferenced and is deleting its object.
    await db.insert(r2ObjectCleanupTasks).values({
      r2Key: assetKey,
      notBefore: now,
      deletingAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const r2 = fakeR2({ [assetKey]: "image-bytes" });
    rooms(r2).set("whiteboard_source", snapshot);

    await expect(duplicateWhiteboard(syncEnv(r2), {
      whiteboardId: "whiteboard_source",
      userId: "user_host",
    })).rejects.toThrow("assets changed");
    await expect(db.query.whiteboardAssetReferences.findFirst({ where: { r2Key: assetKey } }))
      .resolves.toBeUndefined();
    await expect(db.query.whiteboards.findMany({ columns: { id: true } }))
      .resolves.toEqual([{ id: "whiteboard_source" }]);
  });

  it("duplicates a Whiteboard nobody has drawn on yet", async () => {
    // Copying used to read a pinned revision, which a board prepared outside a
    // Meeting never has — so the only boards you could duplicate were the ones
    // a Meeting had already ended on. A copy seeds from the board's room,
    // which even a blank board has.
    const { db, now } = await seedMeeting();
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
    const r2 = fakeR2();

    const copy = await duplicateWhiteboard(syncEnv(r2), {
      whiteboardId: "whiteboard_blank",
      userId: "user_host",
    });

    expect(copy.title).toBe("Copy of Prepared last night");
    await expect(db.query.whiteboards.findFirst({
      where: { id: copy.whiteboardId },
      columns: { title: true, spaceId: true },
    })).resolves.toEqual({ title: "Copy of Prepared last night", spaceId: "user_host_space" });
    expect(rooms(r2).has(copy.whiteboardId)).toBe(true);
  });
});

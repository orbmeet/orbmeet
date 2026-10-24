import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";

import {
  meetingLinks,
  meetings,
  meetingWhiteboards,
  users,
  whiteboards,
} from "@orbmeet/db/schema";

import { eq } from "drizzle-orm";

import { seedPersonalSpace, seedSharedSpace } from "@/test/fixtures";
import {
  attachExistingWhiteboardToMeeting,
  createMeetingWhiteboardDocument,
  createSpaceWhiteboard,
  ensureMeetingWhiteboardDocument,
} from "./documents";
import {
  presentWhiteboardInMeeting,
} from "./document-revisions";

import { seedMeeting, fakeR2, syncEnv, rooms } from "@/test/documents-test-support";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Meeting Whiteboard documents: opening and attaching", () => {
  it("lazily reuses the first Whiteboard opened in a Meeting", async () => {
    const { db } = await seedMeeting();
    const first = await ensureMeetingWhiteboardDocument(db, env, "meeting_1", "user_host");
    const second = await ensureMeetingWhiteboardDocument(db, env, "meeting_1", "user_host");

    expect(first).not.toBeNull();
    expect(second?.whiteboardId).toBe(first?.whiteboardId);
    expect(first?.syncRoomId).toBe(first?.whiteboardId);
    expect(first?.whiteboardId).not.toContain("meeting_1");
    expect(await db.select().from(whiteboards)).toHaveLength(1);
  });

  it("serializes concurrent first opens onto one Whiteboard", async () => {
    const { db } = await seedMeeting();

    const opened = await Promise.all(Array.from({ length: 6 }, () =>
      ensureMeetingWhiteboardDocument(db, env, "meeting_1", "user_host"),
    ));

    expect(new Set(opened.map((document) => document?.whiteboardId)).size).toBe(1);
    expect(await db.select().from(whiteboards)).toHaveLength(1);
    expect(await db.select().from(meetingWhiteboards)).toHaveLength(1);
  });

  it("attaches a board to its own Meeting when the Space holds others", async () => {
    const { db, now } = await seedMeeting();
    // An earlier Meeting of the same Space, sorting ahead of meeting_1.
    await db.insert(meetingLinks).values({
      id: "link_0",
      code: "abc-defg-hik",
      spaceId: "user_host_space",
      spaceKind: "personal",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "meeting_0",
      meetingLinkId: "link_0",
      spaceId: "user_host_space",
      spaceKind: "personal",
      title: "Earlier call",
      startedByUserId: "user_host",
      status: "ended",
      billingPrincipalType: "user",
      billingPrincipalId: "user_host",
      billingPlan: "free",
      startedAt: now,
      endedAt: now,
      updatedAt: now,
    });

    const first = await ensureMeetingWhiteboardDocument(db, env, "meeting_1", "user_host");
    expect(first?.meetingId).toBe("meeting_1");
    const space = await createSpaceWhiteboard(db, {
      spaceId: "user_host_space",
      title: "Roadmap",
      createdByUserId: "user_host",
    });
    await attachExistingWhiteboardToMeeting(db, {
      meetingId: "meeting_1",
      whiteboardId: space.whiteboardId,
      presentedByUserId: "user_host",
    });

    const usages = await db.select().from(meetingWhiteboards);
    expect(usages).toHaveLength(2);
    expect(usages.every((usage) => usage.meetingId === "meeting_1")).toBe(true);
  });

  it("names a Whiteboard created inside a Meeting after that Meeting", async () => {
    // `whiteboards.title` is NOT NULL, so this is the name a person sees and
    // renames — not a fallback computed at read time. The Meeting's own title
    // is something the class already recognizes.
    const { db } = await seedMeeting();
    const document = await createMeetingWhiteboardDocument(db, "meeting_1", "user_host");

    expect(document?.title).toBe("Product review");
    await expect(db.query.whiteboards.findFirst({
      where: { id: document!.whiteboardId },
      columns: { title: true },
    })).resolves.toMatchObject({ title: "Product review" });
  });

  it("falls back to the date when the Meeting itself is untitled", async () => {
    const { db } = await seedMeeting();
    await db.update(meetings).set({ title: null }).where(eq(meetings.id, "meeting_1"));

    const document = await createMeetingWhiteboardDocument(db, "meeting_1", "user_host");

    expect(document?.title).toMatch(/^Whiteboard · [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it("refuses to create a Space Whiteboard with a blank name", async () => {
    const { db } = await seedMeeting();

    await expect(createSpaceWhiteboard(db, {
      spaceId: "user_host_space",
      title: "   ",
      createdByUserId: "user_host",
    })).rejects.toThrow();
    expect(await db.select().from(whiteboards)).toHaveLength(0);
  });

  it("refuses to attach a Whiteboard to a Meeting that has already ended", async () => {
    // Creation checks the Meeting is open, then attaches in a later transaction.
    // Finalization committing in between used to insert a usage no capture task
    // covers, hold the board's live lease against every other Meeting for good,
    // and reopen the surface of an ended Meeting. The attach is now conditional
    // on the Meeting being open inside its own transaction.
    const { db } = await seedMeeting();
    await db
      .update(meetings)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(meetings.id, "meeting_1"));

    await expect(
      createMeetingWhiteboardDocument(db, "meeting_1", "user_host"),
    ).resolves.toBeNull();

    // And nothing was left behind for the ended Meeting.
    expect(await db.select().from(meetingWhiteboards)).toHaveLength(0);
    await expect(db.query.meetingWhiteboardSurfaces.findFirst({
      where: { meetingId: "meeting_1" },
    })).resolves.toBeUndefined();
  });

  it("creates nothing when the Meeting ends mid-flight", async () => {
    // The window the guard exists for: the open check passes, then finalization
    // commits before the attach lands.
    const { db } = await seedMeeting();
    const findFirst = db.query.meetings.findFirst.bind(db.query.meetings);
    // Drizzle's `findFirst` returns a thenable query builder rather than a
    // promise, so the stand-in is cast rather than typed against it.
    const spy = vi.spyOn(db.query.meetings, "findFirst").mockImplementationOnce(
      (async (args: never) => {
        const meeting = await findFirst(args);
        // Between the caller's open check and `attachWhiteboard`.
        await db
          .update(meetings)
          .set({ status: "ended", endedAt: new Date() })
          .where(eq(meetings.id, "meeting_1"));
        return meeting;
      }) as never,
    );

    await expect(
      createMeetingWhiteboardDocument(db, "meeting_1", "user_host"),
    ).rejects.toThrow(/already ended/i);
    spy.mockRestore();

    // The board and its usage commit together or not at all: neither exists,
    // and no surface was published for the ended Meeting.
    expect(await db.select().from(whiteboards)).toHaveLength(0);
    expect(await db.select().from(meetingWhiteboards)).toHaveLength(0);
    await expect(db.query.meetingWhiteboardSurfaces.findFirst({
      where: { meetingId: "meeting_1" },
    })).resolves.toBeUndefined();
  });

  it("can create and attach multiple independent Whiteboards in one Meeting", async () => {
    const { db } = await seedMeeting();
    const first = await ensureMeetingWhiteboardDocument(db, env, "meeting_1", "user_host");
    // No lease to release first: a second board is simply created.
    const second = await createMeetingWhiteboardDocument(db, "meeting_1", "user_host");

    if (!second) throw new Error("Expected a second Whiteboard");
    expect(second.whiteboardId).not.toBe(first?.whiteboardId);
    expect(second.meetingWhiteboardId).not.toBe(first?.meetingWhiteboardId);
    expect(await db.select().from(whiteboards)).toHaveLength(2);
    expect(await db.select().from(meetingWhiteboards)).toHaveLength(2);
  });

  it("attaching presents nothing: focus and the surface belong to the Meeting's room", async () => {
    const { db } = await seedMeeting();
    await ensureMeetingWhiteboardDocument(db, env, "meeting_1", "user_host");
    await createMeetingWhiteboardDocument(db, "meeting_1", "user_host");

    const focused = (await db.select().from(meetingWhiteboards))
      .filter((usage) => usage.focusedAt !== null);
    expect(focused).toHaveLength(0);
    await expect(db.query.meetingWhiteboardSurfaces.findFirst({
      where: { meetingId: "meeting_1" },
    })).resolves.toBeUndefined();
  });

  it("re-presents a Whiteboard the Meeting already used without re-attaching", async () => {
    const { db } = await seedMeeting();
    const first = await ensureMeetingWhiteboardDocument(db, env, "meeting_1", "user_host");
    if (!first) throw new Error("Expected the first Whiteboard");
    await createMeetingWhiteboardDocument(db, "meeting_1", "user_host");

    const reopened = await attachExistingWhiteboardToMeeting(db, {
      meetingId: "meeting_1",
      whiteboardId: first.whiteboardId,
      presentedByUserId: "user_host",
    });

    expect(reopened.whiteboardId).toBe(first.whiteboardId);
    // Switching back reuses the original use rather than recording a second
    // use of the same board in the same Meeting.
    expect(reopened.meetingWhiteboardId).toBe(first.meetingWhiteboardId);
    expect(await db.select().from(meetingWhiteboards)).toHaveLength(2);
  });

  it("refuses to attach a Whiteboard from another Space without copying it", async () => {
    const { db, now } = await seedMeeting();
    await seedSharedSpace(db, {
      id: "space_team",
      ownerUserId: "user_host",
      members: [{ userId: "user_host", role: "owner" }],
      now,
    });
    await db.insert(whiteboards).values({
      id: "whiteboard_team",
      syncRoomId: "whiteboard_team",
      spaceId: "space_team",
      title: "Roadmap",
      createdByUserId: "user_host",
      createdAt: now,
      updatedAt: now,
    });

    await expect(attachExistingWhiteboardToMeeting(db, {
      meetingId: "meeting_1",
      whiteboardId: "whiteboard_team",
      presentedByUserId: "user_host",
    })).rejects.toThrow(/must be copied/i);

    await expect(db.query.whiteboards.findFirst({
      where: { id: "whiteboard_team" },
      columns: { spaceId: true },
    })).resolves.toEqual({ spaceId: "space_team" });
    await expect(db.query.meetingWhiteboards.findFirst({
      where: { meetingId: "meeting_1", whiteboardId: "whiteboard_team" },
      columns: { id: true },
    })).resolves.toBeUndefined();
  });

  it("copies a cross-Space Whiteboard into the Meeting Space before presenting it", async () => {
    const { db, now } = await seedMeeting();
    await seedSharedSpace(db, {
      id: "space_team",
      ownerUserId: "user_host",
      members: [{ userId: "user_host", role: "owner" }],
      now,
    });
    const snapshot = JSON.stringify({ documents: [{ state: { id: "source-shape" } }] });
    await db.insert(whiteboards).values({
      id: "whiteboard_team",
      syncRoomId: "whiteboard_team",
      spaceId: "space_team",
      title: "Roadmap",
      createdByUserId: "user_host",
      createdAt: now,
      updatedAt: now,
    });
    const r2 = fakeR2();
    rooms(r2).set("whiteboard_team", snapshot);

    const presented = await presentWhiteboardInMeeting(
      db,
      syncEnv(r2),
      {
        meetingId: "meeting_1",
        whiteboardId: "whiteboard_team",
        presentedByUserId: "user_host",
      },
    );

    expect(presented.whiteboardId).not.toBe("whiteboard_team");
    expect(presented.copiedFromWhiteboardId).toBe("whiteboard_team");
    await expect(db.query.whiteboards.findFirst({
      where: { id: presented.whiteboardId },
      columns: { spaceId: true, title: true },
    })).resolves.toEqual({ spaceId: "user_host_space", title: "Roadmap" });
    await expect(db.query.meetingWhiteboards.findFirst({
      where: { meetingId: "meeting_1", whiteboardId: presented.whiteboardId },
      columns: { spaceId: true },
    })).resolves.toEqual({ spaceId: "user_host_space" });
    expect(rooms(r2).get(presented.whiteboardId)).toBe(snapshot);
  });

  it("refuses to present a Whiteboard outside the presenter's Spaces", async () => {
    const { db, now } = await seedMeeting();
    await db.insert(users).values({
      id: "user_other",
      name: "Other",
      email: "other@example.com",
      normalizedEmail: "other@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await seedPersonalSpace(db, "user_other", { now });
    await db.insert(whiteboards).values({
      id: "whiteboard_private",
      syncRoomId: "whiteboard_private",
      spaceId: "user_other_space",
      title: "Private",
      createdByUserId: "user_other",
      createdAt: now,
      updatedAt: now,
    });

    await expect(attachExistingWhiteboardToMeeting(db, {
      meetingId: "meeting_1",
      whiteboardId: "whiteboard_private",
      presentedByUserId: "user_host",
    })).rejects.toThrow(/Whiteboard/i);
  });

  it("lets concurrent attachments of one board settle on a single use of it", async () => {
    const { db } = await seedMeeting();
    const first = await ensureMeetingWhiteboardDocument(db, env, "meeting_1", "user_host");
    if (!first) throw new Error("Expected the first Whiteboard");
    await createMeetingWhiteboardDocument(db, "meeting_1", "user_host");

    const attached = await Promise.all([1, 2].map(() =>
      attachExistingWhiteboardToMeeting(db, {
        meetingId: "meeting_1",
        whiteboardId: first.whiteboardId,
        presentedByUserId: "user_host",
      })));

    expect(new Set(attached.map((document) => document.meetingWhiteboardId))).toEqual(
      new Set([first.meetingWhiteboardId]),
    );
    expect(await db.select().from(meetingWhiteboards)).toHaveLength(2);
  });

  it("hands the loser of a race to attach a new board the winner's use of it", async () => {
    const { db } = await seedMeeting();
    const board = await createSpaceWhiteboard(db, {
      spaceId: "user_host_space",
      title: "Plan",
      createdByUserId: "user_host",
    });
    const winner = await attachExistingWhiteboardToMeeting(db, {
      meetingId: "meeting_1",
      whiteboardId: board.whiteboardId,
      presentedByUserId: "user_host",
    });

    // The loser checked for an existing use before the winner's insert landed.
    const findFirst = db.query.meetingWhiteboards.findFirst.bind(db.query.meetingWhiteboards);
    let stale = true;
    db.query.meetingWhiteboards.findFirst = ((...args: Parameters<typeof findFirst>) => {
      if (stale) {
        stale = false;
        return Promise.resolve(undefined);
      }
      return findFirst(...args);
    }) as typeof findFirst;
    const loser = await attachExistingWhiteboardToMeeting(db, {
      meetingId: "meeting_1",
      whiteboardId: board.whiteboardId,
      presentedByUserId: "user_host",
    });

    expect(loser.meetingWhiteboardId).toBe(winner.meetingWhiteboardId);
  });

  it("does not charge archived Whiteboards to the active-document plan limit", async () => {
    const { db, now } = await seedMeeting();
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: `whiteboard_limit_${index}`,
      syncRoomId: `whiteboard_limit_${index}`,
      spaceId: "user_host_space",
      title: `Board ${index}`,
      status: "active" as const,
      createdByUserId: "user_host",
      createdAt: now,
      updatedAt: now,
    }));
    for (let index = 0; index < rows.length; index += 10) {
      await db.insert(whiteboards).values(rows.slice(index, index + 10));
    }
    await expect(createSpaceWhiteboard(db, {
      spaceId: "user_host_space",
      title: "Over the limit",
      createdByUserId: "user_host",
    })).rejects.toThrow(/100-Whiteboard limit/);

    await db.update(whiteboards).set({
      status: "archived",
      archivedAt: now,
      updatedAt: now,
    }).where(eq(whiteboards.id, rows[0].id));

    await expect(createSpaceWhiteboard(db, {
      spaceId: "user_host_space",
      title: "Replacement board",
      createdByUserId: "user_host",
    })).resolves.toMatchObject({ title: "Replacement board" });
    const allBoards = await db.select().from(whiteboards);
    expect(allBoards.filter((board) => board.status === "active")).toHaveLength(100);
    expect(allBoards.filter((board) => board.status === "archived")).toHaveLength(1);
  });
});

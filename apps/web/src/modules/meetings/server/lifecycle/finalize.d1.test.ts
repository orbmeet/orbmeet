import { beforeEach, describe, expect, it } from "vitest";
import { relations, type Database } from "@orbmeet/db";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import {
  meetings,
  meetingLinks,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedMeetingWhiteboard, seedPersonalSpace } from "@/test/fixtures";
import { beginMeetingCloseStatement, finalizeMeetingEnd } from "./finalize";
import { captureMeetingWhiteboards, NOTHING_SHARED_CAPTURE_REASON } from "@/modules/whiteboards/server/meeting/capture";
import { immediateJobStep } from "@/test/jobs";
import { attachExistingWhiteboardToMeeting } from "@/modules/whiteboards/server/documents";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertUser(id: string) {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertMeeting(
  meetingId: string,
  ownerUserId: string,
  activeEgressId: string | null,
  activeStreamEgressId: string | null,
) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  await seedPersonalSpace(db, ownerUserId);
  await db.insert(meetingLinks).values({
    id: `room_${meetingId}`,
    code: "abc-defg-hij",
    reusePolicy: "reusable",
    spaceId: `${ownerUserId}_space`,
    spaceKind: "personal" as const,
    title: "Meeting",
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, ownerUserId);
  await db.insert(meetings).values({
    id: meetingId,
    meetingLinkId: `room_${meetingId}`,
    startedByUserId: ownerUserId,
    spaceId: `${ownerUserId}_space`,
    spaceKind: "personal" as const,
    title: "Meeting",
    status: "open",
    billingPrincipalType: "user" as const,
    billingPrincipalId: ownerUserId,
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    endedAt: null,
    activeEgressId,
    activeStreamEgressId,
    updatedAt: now,
  });
}

describe("finalizeMeetingEnd", () => {
  it("freezes presentation, refuses new attachments, and reuses the capture identity across closing retries", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host", null, null);
    const now = new Date("2026-01-01T00:15:00.000Z");
    for (const [index, focused] of [[1, true], [2, false]] as const) {
      await seedMeetingWhiteboard(db, {
        meetingId: "meeting_1", spaceId: "host_space",
        whiteboardId: `whiteboard_${index}`, meetingWhiteboardId: `usage_${index}`,
        createdByUserId: "host", focused, now,
      });
    }
    await beginMeetingCloseStatement(db, "meeting_1", now);
    const first = await db.query.meetings.findFirst({ where: { id: "meeting_1" } });
    expect(first?.closingWhiteboardId).toBe("usage_1");
    expect(first?.closingCommandId).toBeTruthy();
    await expect(attachExistingWhiteboardToMeeting(db, {
      meetingId: "meeting_1", whiteboardId: "whiteboard_2", presentedByUserId: "host",
    })).rejects.toThrow();
    await beginMeetingCloseStatement(db, "meeting_1", new Date(now.getTime() + 60_000));
    const retried = await db.query.meetings.findFirst({ where: { id: "meeting_1" } });
    expect(retried?.closingCommandId).toBe(first?.closingCommandId);
    expect(retried?.closingAt).toEqual(now);
    expect(retried?.closingWhiteboardId).toBe("usage_1");
    const focused = await db.query.meetingWhiteboards.findFirst({ where: { id: "usage_1" } });
    expect(focused?.focusedAt).not.toBeNull();
    const other = await db.query.meetingWhiteboards.findFirst({ where: { id: "usage_2" } });
    expect(other?.focusedAt).toBeNull();
  });

  it("closes the Meeting surface and leaves its Whiteboards to the capture, without archiving the document", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host", null, null);
    const createdAt = new Date("2026-01-01T00:15:00.000Z");
    await seedMeetingWhiteboard(db, {
      meetingId: "meeting_1",
      spaceId: "host_space",
      whiteboardId: "whiteboard_1",
      title: "Meeting Whiteboard",
      createdByUserId: "host",
      surfaceOpen: false,
      surfaceRevision: 1,
      // The pre-end checkpoint pins the shared generation before the end
      // transaction runs; the capture job reads that object, never the
      // living document.
      lastSharedSnapshotR2Key: "internal/meetings/meeting_1/canvases/whiteboard_1",
      now: createdAt,
    });
    const endedAt = new Date("2026-01-01T01:00:00.000Z");

    await expect(finalizeMeetingEnd(db, {
      reason: "host",
      meetingId: "meeting_1",
      now: endedAt,
      summaryOwed: false,
    })).resolves.toBe(true);
    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" }, columns: { status: true, endReason: true } }))
      .resolves.toEqual({ status: "ended", endReason: "host" });
    // Already ended: nothing more is written, and the reason stays.
    await expect(finalizeMeetingEnd(db, {
      reason: "system",
      meetingId: "meeting_1",
      now: endedAt,
      summaryOwed: false,
    })).resolves.toBe(false);
    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" }, columns: { endReason: true } }))
      .resolves.toEqual({ endReason: "host" });

    // The room starts the capture once the end's pin has landed; until then
    // the usage stays live and the capture decides what it owes.
    await expect(db.query.meetingWhiteboards.findFirst({
      where: { meetingId: "meeting_1", whiteboardId: "whiteboard_1" },
      columns: { captureStatus: true, capturedAt: true },
    })).resolves.toEqual({
      captureStatus: "live",
      capturedAt: null,
    });
    await expect(db.query.meetingWhiteboardSurfaces.findFirst({
      where: { meetingId: "meeting_1" },
    })).resolves.toBeUndefined();
  });

  it("ends when nothing was presented", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host", null, null);
    await expect(finalizeMeetingEnd(db, {
      reason: "host",
      meetingId: "meeting_1",
      now: new Date("2026-01-01T01:00:00.000Z"),
      summaryOwed: false,
    })).resolves.toBe(true);
  });

  it("records a presented-but-never-shared Whiteboard as failed instead of owing a capture", async () => {
    // A board opened and closed without a stroke has no persisted generation,
    // so the checkpoint pins nothing. Owing a capture for it would fail every
    // attempt — capture refuses to read the living document after the
    // boundary, and the boundary writer needs an open Meeting — before
    // landing on this same terminal state.
    await insertUser("host");
    await insertMeeting("meeting_1", "host", null, null);
    await seedMeetingWhiteboard(db, {
      meetingId: "meeting_1",
      spaceId: "host_space",
      whiteboardId: "whiteboard_1",
      title: "Meeting Whiteboard",
      createdByUserId: "host",
      now: new Date("2026-01-01T00:15:00.000Z"),
    });

    await expect(finalizeMeetingEnd(db, {
      reason: "host",
      meetingId: "meeting_1",
      now: new Date("2026-01-01T01:00:00.000Z"),
      summaryOwed: false,
    })).resolves.toBe(true);
    await captureMeetingWhiteboards(immediateJobStep(), db, {} as Env, "meeting_1");

    await expect(db.query.meetingWhiteboards.findFirst({
      where: { meetingId: "meeting_1", whiteboardId: "whiteboard_1" },
      columns: { captureStatus: true, captureFailureReason: true, capturedRevisionId: true },
    })).resolves.toEqual({
      captureStatus: "failed",
      captureFailureReason: NOTHING_SHARED_CAPTURE_REASON,
      capturedRevisionId: null,
    });
  });

});

describe("finalizeMeetingEnd timestamps", () => {
  it("ends a meeting whose start is ahead of the finalizing worker's clock", async () => {
    // `startedAt` is stamped by whichever Worker minted the occurrence; the
    // Worker that ends it is a different request with its own clock, and a cron
    // tick captures `now` many round trips before the batch commits. Unclamped,
    // `endedAt < startedAt` trips `meetings_ended_after_started_check` and rolls
    // back the whole finalization — leaving the meeting open with no teardown.
    await insertUser("host");
    await insertMeeting("meeting_1", "host", null, null);
    const startedAt = new Date("2026-01-01T00:00:00.000Z");

    await expect(
      finalizeMeetingEnd(db, {
        reason: "host",
        meetingId: "meeting_1",
        now: new Date(startedAt.getTime() - 5_000),
        summaryOwed: false,
      }),
    ).resolves.toBe(true);

    const meeting = await db.query.meetings.findFirst({
      where: { id: "meeting_1" },
      columns: { status: true, endedAt: true, updatedAt: true },
    });
    expect(meeting?.status).toBe("ended");
    // Clamped forward to the row's own start rather than the earlier `now`.
    expect(meeting?.endedAt?.getTime()).toBe(startedAt.getTime());
    expect(meeting?.updatedAt?.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
  });

});

describe("finalizeMeetingEnd on D1", () => {
  it("uses prepared query builders for every parameterized batch statement", async () => {
    const boundStatements: Array<{ query: string; values: unknown[] }> = [];
    const preparedStatement = (query: string): D1PreparedStatement => {
      const statement = {
        bind: (...values: unknown[]) => {
          boundStatements.push({ query, values });
          return statement;
        },
      } as unknown as D1PreparedStatement;
      return statement;
    };
    const result = <T>(results: T[]): D1Result<T> => ({
      success: true,
      results,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
        last_row_id: 0,
        changed_db: true,
        changes: 1,
      },
    });
    const client = {
      prepare: preparedStatement,
      batch: async (statements: D1PreparedStatement[]) =>
        statements.map((_, index) =>
          result(index === statements.length - 1 ? [{ id: "meeting_1" }] : []),
        ),
    } as unknown as D1Database;
    const d1Db = drizzleD1(client, { relations }) as unknown as Database;

    await expect(
      finalizeMeetingEnd(d1Db, {
        reason: "host",
        meetingId: "meeting_1",
        now: new Date("2026-07-05T15:11:02.000Z"),
        summaryOwed: true,
      }),
    ).resolves.toBe(true);

    // Capture classification is the capture job's, once the room's pins landed.
    // Edit grants are on the admissions, which end with the meeting's room.
    expect(boundStatements).toHaveLength(2);
    expect(boundStatements.some(({ query }) => query.includes("whiteboard_edit_grants"))).toBe(false);
    expect(boundStatements.some(({ query }) => query.includes("\"summary_status\" = ?"))).toBe(true);
    // Surface visibility is disposable live state, so finalization deletes it
    // while preserving the durable Meeting Whiteboard history.
    expect(boundStatements.some(({ query }) =>
      query.includes("delete from \"meeting_whiteboard_surfaces\"")
    )).toBe(true);
    // Admissions and connections are the meeting room's; the end leaves them be.
    expect(boundStatements.some(({ query }) => query.includes("meeting_admissions"))).toBe(false);
    expect(boundStatements.some(({ query }) => query.includes("meeting_connections"))).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  meetingLinks,
  meetingWhiteboards,
  meetings,
  users,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { seedMeetingWhiteboard, seedPersonalSpace } from "@/test/fixtures";

import {
  snapshotMeta,
  fakeSnapshotHash,
  installFakeSyncServer,
  type ReceivedCommand,
} from "@/test/fake-sync-server";
import { TEST_WHITEBOARD_D1_ENV } from "@/test/whiteboard-d1-env";
import { finalizeMeetingEnd } from "@/modules/meetings/server/lifecycle/finalize";
import { immediateJobStep } from "@/test/jobs";
import {
  captureMeetingWhiteboards,
  deriveWhiteboardCaptureState,
  retryFailedWhiteboardCaptures,
  whiteboardCapturesSettled,
} from "./capture";

const jobs = vi.hoisted(() => ({ started: [] as unknown[], unavailable: false }));
vi.mock("@/platform/jobs/jobs", async (original) => ({
  ...(await original<object>()),
  startJob: async (_env: unknown, job: unknown) => {
    if (jobs.unavailable) throw new Error("Workflows unavailable");
    jobs.started.push(job);
  },
}));

const whiteboardEnv = TEST_WHITEBOARD_D1_ENV as unknown as Env;

function memoryR2() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    bucket: {
      async get(key: string) {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
      },
      async put(key: string, value: ArrayBuffer) {
        objects.set(key, new Uint8Array(value));
      },
      async delete(key: string) {
        objects.delete(key);
      },
    } as unknown as R2Bucket,
  };
}

/**
 * The sync server's side of capture: `copySnapshot` over the test bucket. A
 * missing source answers `not_found`, as the real server does.
 */
function installCopyingSyncServer(r2: ReturnType<typeof memoryR2>): ReceivedCommand[] {
  return installFakeSyncServer({
    copySnapshot: ({ sourceKey, destinationKey }) => {
      const bytes = r2.objects.get(sourceKey);
      if (!bytes) return { ok: false, reason: "not_found", message: "No snapshot stored" };
      r2.objects.set(destinationKey, bytes);
      return {
        ok: true,
        copy: snapshotMeta(destinationKey, {
          hash: fakeSnapshotHash(sourceKey),
          size: bytes.byteLength,
        }),
      };
    },
  }).commands;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedMeetings(
  db: Awaited<ReturnType<typeof createTestDb>>,
  now: Date,
  ids: string[],
  options: { withWhiteboards?: boolean } = {},
) {
  await db.insert(users).values(ids.map((id) => ({
    id: `host_${id}`,
    name: `Host ${id}`,
    email: `host-${id}@example.com`,
    normalizedEmail: `host-${id}@example.com`,
    plan: "free" as const,
    role: "user" as const,
    createdAt: now,
    updatedAt: now,
  })));
  for (const id of ids) await seedPersonalSpace(db, `host_${id}`, { now });
  await db.insert(meetingLinks).values(
    ids.map((id) => ({
      id: `link_${id}`,
      code: `abc-defg-aa${String.fromCharCode(97 + Number(id))}`,
      spaceId: `host_${id}_space`,
      spaceKind: "personal" as const,
      allowGuests: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db.insert(meetings).values(
    ids.map((id) => ({
      id: `meeting_${id}`,
      meetingLinkId: `link_${id}`,
      spaceId: `host_${id}_space`,
      spaceKind: "personal" as const,
      billingPrincipalType: "user" as const,
      billingPrincipalId: `host_${id}`,
      billingPlan: "free" as const,
      startedByUserId: `host_${id}`,
      status: "open" as const,
      allowGuests: true,
      recordingEnabled: false,
      startedAt: new Date(now.getTime() - 60_000),
      updatedAt: now,
    })),
  );
  if (options.withWhiteboards === false) return;
  for (const id of ids) {
    await seedMeetingWhiteboard(db, {
      whiteboardId: `whiteboard_${id}`,
      meetingId: `meeting_${id}`,
      spaceId: `host_${id}_space`,
      title: `Whiteboard ${id}`,
      createdByUserId: `host_${id}`,
      surfaceOpen: false,
      surfaceRevision: 1,
      lastSharedSnapshotR2Key:
        `internal/meetings/meeting_${id}/canvases/whiteboard_${id}/shared.json`,
      now,
    });
  }
}

describe("Whiteboard capture", () => {
  it("derives a Meeting's capture state from each Whiteboard's status", () => {
    expect(deriveWhiteboardCaptureState({ hasWhiteboardState: false, captureStatuses: [] })).toBe("none");
    expect(deriveWhiteboardCaptureState({ hasWhiteboardState: false, captureStatuses: ["failed"] })).toBe("failed");
    expect(deriveWhiteboardCaptureState({ hasWhiteboardState: true, captureStatuses: ["captured", "capturing"] }))
      .toBe("capturing");
    expect(deriveWhiteboardCaptureState({ hasWhiteboardState: true, captureStatuses: ["captured"] })).toBe("captured");
    expect(deriveWhiteboardCaptureState({ hasWhiteboardState: true, captureStatuses: ["captured", "failed"] }))
      .toBe("failed");
  });

  it("keeps an ended meeting's shared Whiteboards unsettled until its capture classifies them", async () => {
    const db = await createTestDb();
    const now = new Date("2026-06-30T10:00:00.000Z");
    await seedMeetings(db, now, ["0"]);

    // The room starts the capture only once its pins landed; until then the
    // usage is still live, and live counts as unsettled.
    await expect(finalizeMeetingEnd(db, { meetingId: "meeting_0", reason: "host", now, summaryOwed: false })).resolves.toBe(true);
    await expect(db.query.meetingWhiteboards.findFirst({
      where: { meetingId: "meeting_0" },
      columns: { captureStatus: true },
    })).resolves.toEqual({ captureStatus: "live" });
    await expect(whiteboardCapturesSettled(db, "meeting_0")).resolves.toBe(false);
  });

  it("records captures as failed when capture is not configured, instead of waiting forever", async () => {
    const db = await createTestDb();
    const now = new Date("2026-06-30T10:00:00.000Z");
    await seedMeetings(db, now, ["0"]);
    await finalizeMeetingEnd(db, { meetingId: "meeting_0", reason: "host", now, summaryOwed: false });

    await captureMeetingWhiteboards(immediateJobStep(), db, {} as Env, "meeting_0");

    await expect(db.query.meetingWhiteboards.findFirst({ where: { meetingId: "meeting_0" } }))
      .resolves.toMatchObject({ captureStatus: "failed", captureFailureReason: expect.stringMatching(/not configured/) });
    await expect(whiteboardCapturesSettled(db, "meeting_0")).resolves.toBe(true);
  });

  it("captures only the pre-end boundary and never re-checkpoints the live document", async () => {
    // A Whiteboard is a Space document whose sync room remains live after a
    // Meeting ends.
    const db = await createTestDb();
    const now = new Date("2026-06-30T10:00:00.000Z");
    const r2 = memoryR2();
    const snapshot = new TextEncoder().encode(JSON.stringify({ documents: [] }));
    const key =
      "internal/meetings/meeting_0/canvases/whiteboard_0/boundary.json";
    r2.objects.set(key, snapshot);

    await seedMeetings(db, now, ["0"]);
    await db.update(meetingWhiteboards).set({
      lastSharedSnapshotR2Key: key,
      lastSharedSnapshotHash: "0".repeat(32),
      lastSharedSnapshotSize: snapshot.byteLength,
      lastSharedAt: now,
    }).where(eq(meetingWhiteboards.meetingId, "meeting_0"));
    await finalizeMeetingEnd(db, { meetingId: "meeting_0", reason: "host", now, summaryOwed: false });
    const commands = installCopyingSyncServer(r2);

    await captureMeetingWhiteboards(immediateJobStep(), db, { ...whiteboardEnv, R2_BUCKET: r2.bucket }, "meeting_0");

    // Delayed capture consumes the immutable pre-end boundary. Touching the
    // live document here would include edits made privately after the Meeting.
    expect(commands).toEqual([
      {
        name: "copySnapshot",
        request: {
          sourceKey: key,
          destinationKey: expect.stringMatching(/^whiteboards\/whiteboard_0\/revisions\//),
        },
      },
    ]);
    await expect(db.query.meetingWhiteboards.findFirst({ where: { meetingId: "meeting_0" } }))
      .resolves.toMatchObject({ captureStatus: "captured", capturedRevisionId: expect.any(String) });
  });

  it("captures later Whiteboards when an earlier one keeps failing, and records that one as failed", async () => {
    const db = await createTestDb();
    const now = new Date("2026-06-30T10:00:00.000Z");
    const r2 = memoryR2();
    const snapshot = new TextEncoder().encode(JSON.stringify({ documents: [] }));
    await seedMeetings(db, now, ["0"]);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_second",
      meetingWhiteboardId: "usage_second",
      meetingId: "meeting_0",
      spaceId: "host_0_space",
      title: "Second board",
      createdByUserId: "host_0",
      surfaceOpen: false,
      surfaceRevision: 2,
      focused: false,
      now,
    });
    const secondSnapshotKey =
      "internal/meetings/meeting_0/canvases/whiteboard_second/shared.json";
    r2.objects.set(secondSnapshotKey, snapshot);
    await db.update(meetingWhiteboards).set({
      lastSharedSnapshotR2Key: secondSnapshotKey,
      lastSharedSnapshotHash: "a".repeat(32),
      lastSharedSnapshotSize: snapshot.byteLength,
      lastSharedDocumentClock: 1,
      lastSharedAt: now,
    }).where(eq(meetingWhiteboards.id, "usage_second"));
    await finalizeMeetingEnd(db, { meetingId: "meeting_0", reason: "host", now, summaryOwed: false });

    // The first board's boundary snapshot was never stored, so its copy fails.
    installCopyingSyncServer(r2);
    const step = immediateJobStep();
    await captureMeetingWhiteboards(step, db, { ...whiteboardEnv, R2_BUCKET: r2.bucket }, "meeting_0");

    await expect(db.query.meetingWhiteboards.findFirst({ where: { id: "usage_second" } })).resolves.toMatchObject({
      captureStatus: "captured",
      capturedRevisionId: expect.any(String),
    });
    await expect(db.query.meetingWhiteboards.findFirst({ where: { whiteboardId: "whiteboard_0" } }))
      .resolves.toMatchObject({ captureStatus: "failed", captureFailureReason: expect.any(String) });
    expect(step.names.filter((name) => name.startsWith("record failed capture"))).toHaveLength(1);
  });

  it("starts failed captures over as a new job, which reopens them itself", async () => {
    const db = await createTestDb();
    const now = new Date("2026-06-30T10:00:00.000Z");
    await seedMeetings(db, now, ["0"]);
    await finalizeMeetingEnd(db, { meetingId: "meeting_0", reason: "host", now, summaryOwed: false });
    await expect(retryFailedWhiteboardCaptures(db, whiteboardEnv, "meeting_0")).resolves.toBe(false);

    await captureMeetingWhiteboards(immediateJobStep(), db, {} as Env, "meeting_0");
    jobs.started.length = 0;
    await expect(retryFailedWhiteboardCaptures(db, whiteboardEnv, "meeting_0")).resolves.toBe(true);
    expect(jobs.started).toEqual([expect.objectContaining({ kind: "captureMeetingWhiteboards", meetingId: "meeting_0" })]);

    const step = immediateJobStep();
    await captureMeetingWhiteboards(step, db, {} as Env, "meeting_0", { reopenFailed: true });
    expect(step.names.slice(0, 3)).toEqual([
      "reopen failed captures",
      "classify presented whiteboards",
      "list whiteboards to capture",
    ]);
  });

  it("stays retryable when the retry's job cannot be started", async () => {
    const db = await createTestDb();
    const now = new Date("2026-06-30T10:00:00.000Z");
    await seedMeetings(db, now, ["0"]);
    await finalizeMeetingEnd(db, { meetingId: "meeting_0", reason: "host", now, summaryOwed: false });
    await captureMeetingWhiteboards(immediateJobStep(), db, {} as Env, "meeting_0");

    jobs.unavailable = true;
    await expect(retryFailedWhiteboardCaptures(db, whiteboardEnv, "meeting_0")).rejects.toThrow("Workflows unavailable");
    jobs.unavailable = false;
    await expect(db.query.meetingWhiteboards.findFirst({ where: { meetingId: "meeting_0" } }))
      .resolves.toMatchObject({ captureStatus: "failed" });
    await expect(retryFailedWhiteboardCaptures(db, whiteboardEnv, "meeting_0")).resolves.toBe(true);
  });
});

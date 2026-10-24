import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:workers";
import { meetingLinks, meetings, r2ObjectCleanupTasks, uploadReservations, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { RECORDING_UPLOAD_MAX_RETRIES } from "./recordings-queue";
import {
  commitRecordingArtifact,
  registerUnregisteredRecordings,
  registerUploadedRecording,
  registerUploadedRecordings,
} from "./recordings.server";

let db: TestDb;
// Past and second-aligned: CHECK constraints compare against createdAt.
const T0 = Math.floor((Date.now() - 60 * 60_000) / 1000) * 1000;
const KEY = "meetings/meeting_1/recordings/orbmeet-meeting_1-2026-10-08T124500.mp4";

/** Just enough R2 for registration: which objects exist, and what was deleted. */
function storage(keys: string[] = [KEY]) {
  const objects = new Set(keys);
  const deleted: string[] = [];
  const bucket = {
    head: async (key: string) => (objects.has(key) ? { key } : null),
    delete: async (key: string) => {
      deleted.push(key);
      objects.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects, deleted };
}

/** The body R2 sends for an upload. */
const uploaded = (key = KEY, size = 4_000) => ({
  account: "account",
  action: "CompleteMultipartUpload",
  bucket: "orbmeet-storage",
  object: { key, size, eTag: "etag" },
  eventTime: new Date(T0).toISOString(),
});

const artifacts = () => db.query.meetingArtifacts.findMany({ where: { meetingId: "meeting_1" } });

beforeEach(async () => {
  db = await createTestDb();
  const at = new Date(T0);
  await db.insert(users).values({
    id: "host", name: "Host", email: "host@example.com", normalizedEmail: "host@example.com",
    plan: "free", role: "user", createdAt: at, updatedAt: at,
  });
  await seedPersonalSpace(db, "host", { now: at });
  await db.insert(meetingLinks).values({
    id: "link_1", code: "abc-defg-hij", spaceId: "host_space", spaceKind: "personal",
    allowGuests: true, createdAt: at, updatedAt: at,
  });
  await db.insert(meetings).values({
    id: "meeting_1", meetingLinkId: "link_1", spaceId: "host_space", spaceKind: "personal",
    startedByUserId: "host", status: "open", billingPrincipalType: "user", billingPrincipalId: "host",
    billingPlan: "free", allowGuests: true, recordingEnabled: true, joinPolicy: "open",
    startedAt: at, updatedAt: at,
  });
});

describe("registerUploadedRecording", () => {
  it("registers an uploaded recording, once however often the event arrives", async () => {
    const r2 = storage();
    await registerUploadedRecording(db, r2.bucket, uploaded());
    await registerUploadedRecording(db, r2.bucket, uploaded());

    expect(await artifacts()).toEqual([
      expect.objectContaining({ r2Key: KEY, type: "recording", size: 4_000, filename: KEY.split("/").pop() }),
    ]);
    expect(r2.deleted).toEqual([]);
  });

  it("deletes a recording that does not fit the quota", async () => {
    const r2 = storage();
    await db.insert(uploadReservations).values({
      id: "reservation_1", principal: "user:host", scope: "upload", bytes: 1024 * 1024 * 1024,
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(T0),
    });

    await registerUploadedRecording(db, r2.bucket, uploaded());

    expect(await artifacts()).toEqual([]);
    expect(r2.deleted).toEqual([KEY]);
  });

  it("deletes a recording whose meeting is gone", async () => {
    const r2 = storage();
    await db.delete(meetings).where(eq(meetings.id, "meeting_1"));

    await registerUploadedRecording(db, r2.bucket, uploaded());

    expect(r2.deleted).toEqual([KEY]);
  });

  it("does not register a recording deleted before its event arrived", async () => {
    await registerUploadedRecording(db, storage([]).bucket, uploaded());
    expect(await artifacts()).toEqual([]);
  });

  it("does not register a recording the cleanup queue is deleting", async () => {
    const r2 = storage();
    const now = new Date();
    await db.insert(r2ObjectCleanupTasks).values({
      r2Key: KEY, notBefore: now, attempts: 0, deletingAt: now, createdAt: now, updatedAt: now,
    });

    await registerUploadedRecording(db, r2.bucket, uploaded());

    expect(await artifacts()).toEqual([]);
    expect(r2.deleted).toEqual([KEY]);
  });

  it("leaves every other object alone", async () => {
    const r2 = storage(["meetings/meeting_1/exports/whiteboard/p.mp4"]);
    await registerUploadedRecording(db, r2.bucket, uploaded("meetings/meeting_1/exports/whiteboard/p.mp4"));
    expect(await artifacts()).toEqual([]);
    expect(r2.deleted).toEqual([]);
  });
});

describe("registerUploadedRecordings", () => {
  function message(body: unknown, attempts = 1) {
    return { body, attempts, ack: vi.fn(), retry: vi.fn() };
  }
  const batch = (...messages: ReturnType<typeof message>[]) =>
    ({ queue: "orbmeet-recordings", messages }) as unknown as MessageBatch<unknown>;
  const env = (bucket: R2Bucket) => ({ DB: testEnv.DB, R2_BUCKET: bucket }) as Env;

  it("acknowledges what it registered, and what can never be registered", async () => {
    const good = message(uploaded());
    const malformed = message({ object: { key: KEY } });
    await registerUploadedRecordings(batch(good, malformed), env(storage().bucket));

    expect(good.ack).toHaveBeenCalled();
    expect(malformed.ack).toHaveBeenCalled();
    expect(await artifacts()).toHaveLength(1);
  });

  it("retries a failure later and later, and gives up only after the last retry", async () => {
    const failing = { head: async () => { throw new Error("R2 unavailable"); } } as unknown as R2Bucket;
    const first = message(uploaded(), 1);
    const later = message(uploaded(), 5);
    const last = message(uploaded(), RECORDING_UPLOAD_MAX_RETRIES + 1);
    await registerUploadedRecordings(batch(first, later, last), env(failing));

    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(later.retry).toHaveBeenCalledWith({ delaySeconds: 960 });
    expect(last.retry).not.toHaveBeenCalled();
    expect(last.ack).toHaveBeenCalled();
  });
});

describe("registerUnregisteredRecordings", () => {
  const HOUR = 60 * 60_000;
  const now = new Date(T0 + 24 * HOUR);

  /** A bucket that lists what it holds, with when each was uploaded. */
  function listing(objects: Record<string, { size: number; uploaded: number }>) {
    const r2 = storage(Object.keys(objects));
    const bucket = Object.assign(r2.bucket, {
      list: async ({ prefix }: R2ListOptions) => ({
        objects: Object.entries(objects)
          .filter(([key]) => key.startsWith(prefix ?? "") && r2.objects.has(key))
          .map(([key, { size, uploaded }]) => ({ key, size, uploaded: new Date(uploaded) })),
        truncated: false,
        delimitedPrefixes: [],
      }),
    });
    return { ...r2, bucket: bucket as R2Bucket };
  }

  it("registers a recording its notification never did, and nothing else", async () => {
    const young = "meetings/meeting_1/recordings/young.mp4";
    const handout = "meetings/meeting_1/exports/whiteboard/p.pdf";
    const r2 = listing({
      [KEY]: { size: 4_000, uploaded: T0 },
      [young]: { size: 1, uploaded: now.getTime() - HOUR },
      [handout]: { size: 1, uploaded: T0 },
    });

    await expect(registerUnregisteredRecordings(db, r2.bucket, now)).resolves.toEqual({ registered: 1 });
    expect((await artifacts()).map((artifact) => artifact.r2Key)).toEqual([KEY]);
    // Already registered: a second walk finds nothing to do.
    await expect(registerUnregisteredRecordings(db, r2.bucket, now)).resolves.toEqual({ registered: 0 });
  });

  it("deletes an unregistered recording whose meeting is gone", async () => {
    const orphan = "meetings/meeting_gone/recordings/a.mp4";
    const r2 = listing({ [orphan]: { size: 1, uploaded: T0 } });

    await registerUnregisteredRecordings(db, r2.bucket, now);
    expect(r2.deleted).toEqual([orphan]);
  });
});

describe("commitRecordingArtifact", () => {
  it("refuses a key outside the meeting's recordings", async () => {
    await expect(commitRecordingArtifact(db, storage().bucket, {
      meetingId: "meeting_1", r2Key: "meetings/other/recordings/a.mp4", bytes: 1, now: new Date(),
    })).rejects.toThrow(/outside/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { meetingLinks, meetings, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { withInlineJobs } from "@/test/jobs";
import { resumeStrandedAccountDeletions } from "./pipeline.server";

const STRANDED_AT = new Date("2026-06-30T08:00:00.000Z");
const JUST_NOW = new Date("2026-06-30T09:55:00.000Z");
const SWEEP_TIME = new Date("2026-06-30T10:00:00.000Z");

function createBucket(initialKeys: string[]) {
  const keys = new Set(initialKeys);
  const bucket = {
    delete: vi.fn(async (input: string | string[]) => {
      for (const key of Array.isArray(input) ? input : [input]) keys.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix?: string }) => ({
      objects: [...keys]
        .filter((key) => key.startsWith(prefix ?? ""))
        .map((key) => ({ key })),
      truncated: false,
    })),
  } as unknown as R2Bucket;
  return bucket;
}

async function seedStrandedDeletion(
  db: TestDb,
  userId: string,
  deletionStartedAt: Date,
  linkCode: string,
) {
  // The archived-at CHECK compares against created-at, so the rows must be
  // older than the deletion marker they are archived with.
  const now = new Date(deletionStartedAt.getTime() - 60_000);
  await db.insert(users).values({
    id: userId,
    name: "Stranded",
    email: `${userId}@example.com`,
    normalizedEmail: `${userId}@example.com`,
    plan: "free",
    role: "user",
    deletionStartedAt,
    createdAt: now,
    updatedAt: now,
  });
  const spaceId = await seedPersonalSpace(db, userId, { now });
  await db.insert(meetingLinks).values({
    id: `${userId}_link`,
    code: linkCode,
    spaceId,
    spaceKind: "personal" as const,
    title: "Stranded link",
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: `${userId}_meeting`,
    meetingLinkId: `${userId}_link`,
    spaceId,
    spaceKind: "personal" as const,
    startedByUserId: userId,
    title: "Stranded meeting",
    status: "ended" as const,
    billingPrincipalType: "user" as const,
    billingPrincipalId: userId,
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    endedAt: now,
    updatedAt: now,
  });
  return { spaceId };
}

describe("stranded account deletion sweep", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  /** Jobs run inline as the sweep starts them, against `bucket`. */
  function sweepEnv(bucket: R2Bucket) {
    return withInlineJobs({ R2_BUCKET: bucket }) as unknown as Env & { started: Array<{ kind: string }> };
  }

  it("drives a stranded deletion to completion and erases the account", async () => {
    const { spaceId } = await seedStrandedDeletion(db, "stranded_1", STRANDED_AT, "aaa-bbbb-aaa");
    const env = sweepEnv(createBucket([]));

    await expect(resumeStrandedAccountDeletions(db, env, SWEEP_TIME)).resolves.toBe(1);

    // The user row (and its marker) is gone — completion is self-marking.
    await expect(
      db.query.users.findFirst({ where: { id: "stranded_1" } }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.spaces.findFirst({ where: { id: spaceId } }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "stranded_1_link" } }),
    ).resolves.toBeUndefined();
    // The delayed R2 cleanup starts from the original marker timestamp,
    // exactly as a deletion started by its own request would.
    expect(env.started).toEqual([
      expect.objectContaining({ kind: "deleteAccount", userId: "stranded_1", exceptSessionId: null }),
      expect.objectContaining({
        kind: "accountCleanup",
        userId: "stranded_1",
        personalSpaceId: spaceId,
        requestedAt: STRANDED_AT.getTime(),
      }),
    ]);
  });

  it("respects the grace period and leaves an in-flight deletion alone", async () => {
    await seedStrandedDeletion(db, "in_flight", JUST_NOW, "aaa-bbbb-bbb");
    const env = sweepEnv(createBucket([]));

    await expect(resumeStrandedAccountDeletions(db, env, SWEEP_TIME)).resolves.toBe(0);

    expect(env.started).toEqual([]);
    await expect(
      db.query.users.findFirst({ where: { id: "in_flight" } }),
    ).resolves.toBeTruthy();
  });

  it("never drives accounts that are not deletion-gated", async () => {
    const now = new Date();
    await db.insert(users).values({
      id: "plain_user",
      name: "Plain",
      email: "plain@example.com",
      normalizedEmail: "plain@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    });

    await expect(resumeStrandedAccountDeletions(db, sweepEnv(createBucket([])), SWEEP_TIME)).resolves.toBe(0);

    await expect(
      db.query.users.findFirst({ where: { id: "plain_user" } }),
    ).resolves.toBeTruthy();
  });

  it("keeps the deletion marker when the job fails, and restarts it on the next run", async () => {
    await seedStrandedDeletion(db, "failing_1", STRANDED_AT, "aaa-bbbb-ccc");
    // Both operations throw: the job lists prefixes before deleting, so the
    // failure has to surface from the list call.
    const failing = {
      delete: vi.fn(async () => {
        throw new Error("R2 unavailable");
      }),
      list: vi.fn(async () => {
        throw new Error("R2 unavailable");
      }),
    } as unknown as R2Bucket;
    const env = sweepEnv(failing);

    await resumeStrandedAccountDeletions(db, env, SWEEP_TIME);

    const row = await db.query.users.findFirst({
      where: { id: "failing_1" },
      columns: { deletionStartedAt: true },
    });
    // Clearing the marker would reopen the ownership races it closed; the
    // contract is: failure leaves it for the next run.
    expect(row?.deletionStartedAt?.getTime()).toBe(STRANDED_AT.getTime());

    // The next run finds the failed job and restarts it, which finishes.
    env.R2_BUCKET = createBucket([]);
    await resumeStrandedAccountDeletions(db, env, new Date(SWEEP_TIME.getTime() + 24 * 60 * 60_000));
    expect(env.started.filter((job) => job.kind === "deleteAccount")).toHaveLength(2);
    await expect(
      db.query.users.findFirst({ where: { id: "failing_1" } }),
    ).resolves.toBeUndefined();
  });
});

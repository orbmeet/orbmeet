import { beforeEach, describe, expect, it, vi } from "vitest";
import { meetingLinks, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import {
  getRunChanges,
  isRetryableD1Error,
  isUniqueConstraintError,
  withD1Retry,
} from "./db-utils";

const NOW = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);

describe("getRunChanges", () => {
  it("reads changes from actual D1 results", async () => {
    const db = await createTestDb();
    const row = {
      id: "run_changes",
      name: "Run Changes",
      email: "run-changes@example.com",
      normalizedEmail: "run-changes@example.com",
      plan: "free" as const,
      role: "user" as const,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const inserted = await db.insert(users).values(row).onConflictDoNothing().run();
    const skipped = await db.insert(users).values(row).onConflictDoNothing().run();

    expect(getRunChanges(inserted)).toBe(1);
    expect(getRunChanges(skipped)).toBe(0);
  });
});

describe("isUniqueConstraintError", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  // This pins the reason the helper exists at all. Drizzle wraps every driver
  // failure in a DrizzleQueryError whose own message is always "Failed query:
  // …", so the constraint text only ever appears in `cause`. Matching the
  // top-level message — which every insert site used to do inline — finds
  // nothing, in tests and on D1 alike.
  it("recognises a violation raised through Drizzle, which the message alone does not", async () => {
    const row = {
      id: "u1",
      name: "A",
      email: "a@example.com",
      normalizedEmail: "a@example.com",
      plan: "free" as const,
      role: "user" as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await db.insert(users).values(row);

    const error = await db
      .insert(users)
      .values({ ...row, id: "u2" })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.includes("UNIQUE")).toBe(false);
    expect(isUniqueConstraintError(error)).toBe(true);
  });

  it("recognises a duplicate meeting code", async () => {
    await db.insert(users).values({
      id: "host",
      name: "Host",
      email: "host@example.com",
      normalizedEmail: "host@example.com",
      plan: "free",
      role: "user",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await seedPersonalSpace(db, "host", { now: NOW });
    const link = {
      code: "abc-defg-hij",
      spaceId: "host_space",
      spaceKind: "personal" as const,
      allowGuests: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await db.insert(meetingLinks).values({ ...link, id: "link_1" });

    const error = await db
      .insert(meetingLinks)
      .values({ ...link, id: "link_2" })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(isUniqueConstraintError(error)).toBe(true);
  });

  it("does not fire on unrelated failures", () => {
    expect(isUniqueConstraintError(new Error("D1_ERROR: no such table: widgets"))).toBe(false);
    expect(isUniqueConstraintError(new Error("FOREIGN KEY constraint failed"))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError("nope")).toBe(false);
  });

  it("reads through a cause chain and terminates on a cyclic one", () => {
    const cyclic = new Error("outer") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(isUniqueConstraintError(cyclic)).toBe(false);

    expect(
      isUniqueConstraintError(
        new Error('Failed query: insert into "users"', {
          cause: new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: users.normalized_email"),
        }),
      ),
    ).toBe(true);
  });
});

describe("isRetryableD1Error", () => {
  it("matches transient failures at any depth of the cause chain", () => {
    expect(isRetryableD1Error(new Error("Network connection lost"))).toBe(true);
    expect(
      isRetryableD1Error(
        new Error("Failed query: select 1", { cause: new Error("Network connection lost.") }),
      ),
    ).toBe(true);
  });

  it("does not retry a constraint violation", () => {
    expect(
      isRetryableD1Error(
        new Error("Failed query: insert", {
          cause: new Error("UNIQUE constraint failed: users.normalized_email"),
        }),
      ),
    ).toBe(false);
  });
});

describe("withD1Retry", () => {
  it("retries documented transient failures for idempotent operations", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network connection lost"))
      .mockResolvedValue("ok");

    await expect(
      withD1Retry(operation, { idempotent: true, baseDelayMs: 0 }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry broad timeout errors", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("request timed out"));

    await expect(
      withD1Retry(operation, { idempotent: true, baseDelayMs: 0 }),
    ).rejects.toThrow("request timed out");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid retry attempt count %s", async (maxAttempts) => {
  let calls = 0;
  await expect(withD1Retry(async () => { calls++; }, { idempotent: true, maxAttempts })).rejects.toThrow(RangeError);
  expect(calls).toBe(0);
});

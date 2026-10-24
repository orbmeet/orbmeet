import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { meetingLinks, spaceMembers, spaces, users } from "@orbmeet/db/schema";

import { createTestDb, type TestDb } from "@/test/db";
import { ensurePersonalSpace, findPersonalSpaceId } from "./personal";

describe("personal Space provisioning", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("has no personal Space until the first write that needs one", async () => {
    const now = new Date("2026-07-19T14:00:00.000Z");
    await db.insert(users).values({
      id: "usr_new",
      name: "New Account",
      email: "new@example.com",
      normalizedEmail: "new@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    });

    await expect(findPersonalSpaceId(db, "usr_new")).resolves.toBeNull();
    const spaceId = await ensurePersonalSpace(db, { id: "usr_new", name: "New Account" }, now);
    await expect(findPersonalSpaceId(db, "usr_new")).resolves.toBe(spaceId);
  });

  it("creates only the Space and owner membership, without an implicit meeting link", async () => {
    const now = new Date("2026-07-19T14:00:00.000Z");
    await db.insert(users).values({
      id: "usr_personal",
      name: "Personal Owner",
      email: "personal@example.com",
      normalizedEmail: "personal@example.com",
      image: null,
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    });

    const spaceId = await ensurePersonalSpace(db, {
      id: "usr_personal",
      name: "Personal Owner",
    }, now);

    await expect(db.query.spaces.findFirst({
      where: { id: spaceId },
    })).resolves.toMatchObject({
      kind: "personal",
      ownerUserId: "usr_personal",
    });
    await expect(db.query.spaceMembers.findFirst({
      where: { spaceId, userId: "usr_personal" },
    })).resolves.toMatchObject({ role: "admin" });

    const links = await db
      .select({ id: meetingLinks.id })
      .from(meetingLinks)
      .where(eq(meetingLinks.spaceId, spaceId));
    expect(links).toEqual([]);

    await expect(ensurePersonalSpace(db, {
      id: "usr_personal",
      name: "Renamed Owner",
    }, now)).resolves.toBe(spaceId);
    await expect(db.$count(spaces, eq(spaces.ownerUserId, "usr_personal"))).resolves.toBe(1);
    await expect(db.$count(spaceMembers, eq(spaceMembers.spaceId, spaceId))).resolves.toBe(1);
  });

  it("does not recreate a personal ownership row after deletion starts", async () => {
    const now = new Date("2026-07-19T14:00:00.000Z");
    await db.insert(users).values({
      id: "usr_deleting",
      name: "Deleting Owner",
      email: "deleting@example.com",
      normalizedEmail: "deleting@example.com",
      plan: "free",
      role: "user",
      deletionStartedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(ensurePersonalSpace(db, {
      id: "usr_deleting",
      name: "Deleting Owner",
    }, now)).rejects.toThrow("Failed to provision the personal space");
    await expect(db.$count(spaces, eq(spaces.ownerUserId, "usr_deleting")))
      .resolves.toBe(0);
  });
});

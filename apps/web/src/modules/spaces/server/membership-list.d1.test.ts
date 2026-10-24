import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { spaceMembers, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedSharedSpace } from "@/test/fixtures";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { listSpaceMembersImpl } from "./membership.server";

let db: TestDb;
const base = new Date("2026-09-25T10:00:00.000Z");
const people = ["owner", "ada", "bob", "cy", "dee"];

beforeEach(async () => {
  db = await createTestDb();
  for (const id of people) {
    await db.insert(users).values({
      id,
      name: id,
      email: `${id}@example.com`,
      normalizedEmail: `${id}@example.com`,
      plan: "free",
      role: "user",
      createdAt: base,
      updatedAt: base,
    });
  }
  await seedSharedSpace(db, {
    id: "space_1",
    ownerUserId: "owner",
    now: base,
    members: [{ userId: "owner", role: "owner" }],
  });
  // Joined one minute apart, in order.
  for (const [index, userId] of people.slice(1).entries()) {
    await db.insert(spaceMembers).values({
      id: `space_1_${userId}`,
      spaceId: "space_1",
      userId,
      role: "member",
      joinedAt: new Date(base.getTime() + (index + 1) * 60_000),
    });
  }
});

const list = (cursor?: string) =>
  listSpaceMembersImpl({
    data: { spaceId: "space_1", limit: 2, cursor },
    context: { user: { id: "owner" }, db } as unknown as AuthFnContext,
  });
const userIds = (page: Awaited<ReturnType<typeof list>>) => page.members.map((member) => member.userId);

describe("listSpaceMembersImpl", () => {
  it("does not skip anyone when a member on an earlier page is removed", async () => {
    const first = await list();
    expect(userIds(first)).toEqual(["owner", "ada"]);

    await db.delete(spaceMembers).where(eq(spaceMembers.id, "space_1_ada"));

    const second = await list(first.nextCursor);
    expect(userIds(second)).toEqual(["bob", "cy"]);
    const third = await list(second.nextCursor);
    expect(userIds(third)).toEqual(["dee"]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("refuses a cursor it did not issue", async () => {
    await expect(list("2")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

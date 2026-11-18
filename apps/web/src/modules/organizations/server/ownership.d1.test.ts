import { beforeEach, describe, expect, it, vi } from "vitest";
import { organizationMembers, organizationOwnershipTransfers, organizations, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import type { AuthFnContext } from "@/app/bootstrap/middleware";

vi.mock("@/platform/http/rate-limit.server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/platform/http/rate-limit.server")>(),
  enforceRateLimit: vi.fn(async () => undefined),
}));

import { acceptOrganizationOwnershipTransferImpl } from "./ownership.server";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date();
  await db.insert(users).values(["founder", "heir"].map((id) => ({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    role: "user" as const,
    createdAt: now,
    updatedAt: now,
  })));
  await db.insert(organizations).values({ id: "org_1", name: "Acme", ownerId: "founder", createdAt: now, updatedAt: now });
  await db.insert(organizationMembers).values([
    // The creator's own membership, as creating an Organization writes it.
    { id: "om_founder", organizationId: "org_1", userId: "founder", role: "admin", joinedAt: now },
    { id: "om_heir", organizationId: "org_1", userId: "heir", role: "member", joinedAt: now },
  ]);
  await db.insert(organizationOwnershipTransfers).values({
    organizationId: "org_1",
    requestedByUserId: "founder",
    proposedOwnerUserId: "heir",
    expiresAt: new Date(now.getTime() + 60 * 60_000),
    createdAt: now,
  });
});

const accept = () => acceptOrganizationOwnershipTransferImpl({
  data: { organizationId: "org_1" },
  context: { user: { id: "heir" }, db, env: {} } as unknown as AuthFnContext,
});
const roleOf = async (userId: string) =>
  (await db.query.organizationMembers.findFirst({ where: { organizationId: "org_1", userId } }))?.role;

describe("accepting an Organization ownership transfer", () => {
  it("makes the recipient the owner and the former owner a member", async () => {
    await expect(accept()).resolves.toEqual({ success: true });

    await expect(db.query.organizations.findFirst({ where: { id: "org_1" } })).resolves.toMatchObject({ ownerId: "heir" });
    await expect(roleOf("founder")).resolves.toBe("member");
  });

  it("leaves the former owner's role alone when the transfer does not happen", async () => {
    // The recipient left the Organization before accepting.
    await db.delete(organizationMembers).where(eq(organizationMembers.userId, "heir"));

    await expect(accept()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(roleOf("founder")).resolves.toBe("admin");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { organizations, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { seedSubscription } from "@/test/billing";
import {
  loadOrganizationPlan,
  loadUserBilling,
  organizationBillingSelection,
  userPlanSql,
} from "./entitlements.server";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date();
  await db.insert(users).values([
    { id: "pro", name: "Pro", email: "pro@example.com", normalizedEmail: "pro@example.com", role: "user", createdAt: now, updatedAt: now },
    { id: "free", name: "Free", email: "free@example.com", normalizedEmail: "free@example.com", role: "user", createdAt: now, updatedAt: now },
  ]);
  await db.insert(organizations).values([
    { id: "org_paid", name: "Paid", ownerId: "pro", createdAt: now, updatedAt: now },
    { id: "org_unfunded", name: "Unfunded", ownerId: "free", createdAt: now, updatedAt: now },
  ]);
  await seedSubscription(db, { userId: "pro" });
  await seedSubscription(db, { organizationId: "org_paid", seats: 7 }, { cancelAtPeriodEnd: true });
});

describe("derived plans", () => {
  it("binds to the outer row in a single-table query, where Drizzle drops the table name", async () => {
    const rows = await db.select({ id: users.id, plan: userPlanSql(users.id) }).from(users).orderBy(users.id);
    expect(rows).toEqual([{ id: "free", plan: "free" }, { id: "pro", plan: "pro" }]);
  });

  it("reads a user's billing", async () => {
    await expect(loadUserBilling(db, "pro")).resolves.toEqual({
      plan: "pro",
      subscriptionStatus: "active",
      hasManagedSubscription: true,
    });
    await expect(loadUserBilling(db, "free")).resolves.toEqual({
      plan: "free",
      subscriptionStatus: null,
      hasManagedSubscription: false,
    });
    await expect(loadUserBilling(db, "missing")).resolves.toMatchObject({ plan: "free" });
  });

  it("reads an Organization's plan and seats from its own subscription", async () => {
    await expect(loadOrganizationPlan(db, "org_paid")).resolves.toBe("organization");
    await expect(loadOrganizationPlan(db, "org_unfunded")).resolves.toBe("free");
    const [paid] = await db
      .select(organizationBillingSelection(organizations.id))
      .from(organizations)
      .where(eq(organizations.id, "org_paid"));
    expect(paid).toEqual({
      plan: "organization",
      subscriptionStatus: "active",
      seats: 7,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: null,
    });
  });
});

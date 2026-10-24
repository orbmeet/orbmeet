import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  organizationMembers,
  organizationOwnershipTransfers,
  organizations,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { eq } from "drizzle-orm";

const getSubscriptionMock = vi.hoisted(() => vi.fn());
const updateSubscriptionQuantityMock = vi.hoisted(() => vi.fn());

vi.mock("@/modules/billing/server/paddle", () => ({
  getSubscription: getSubscriptionMock,
  updateSubscriptionQuantity: updateSubscriptionQuantityMock,
}));

import { transferOrganizationBillingOwnership } from "./organization-transfer.server";

let db: TestDb;
/** What Paddle holds: each subscription's seat quantity, as the fake API reads and writes it. */
let paddleQuantities: Map<string, number>;
const acceptedAt = new Date("2026-08-17T09:00:00.000Z");

// Make the commit probe's by-id organization read fail from its second use on
// (the first one is the transfer's own initial read). This is how a D1 outage
// between the Paddle writes and the compensation decision is simulated.
// Returns the spy so tests can restore real reads afterwards.
function failProbeReadsById() {
  const original = db.query.organizations.findFirst.bind(db.query.organizations);
  let byIdReads = 0;
  return vi.spyOn(db.query.organizations, "findFirst").mockImplementation((config) => {
    const where = (config as { where?: Record<string, unknown> } | undefined)?.where;
    if (where && "id" in where) {
      byIdReads += 1;
      if (byIdReads > 1) throw new Error("D1 read failed");
    }
    return original(config);
  });
}

const env = {
  PADDLE_API_KEY: "test-key",
  PADDLE_PRICE_ID_ORG_SEAT: "pri_01test000000000000000seat",
} as unknown as Env;

beforeEach(async () => {
  db = await createTestDb();
  getSubscriptionMock.mockReset();
  updateSubscriptionQuantityMock.mockReset();

  await db.insert(users).values([
    {
      id: "old_owner",
      name: "Old owner",
      email: "old@example.com",
      normalizedEmail: "old@example.com",
      plan: "organization",
      paddleCustomerId: "customer-old",
      paddleSubscriptionId: "subscription-old",
      subscriptionStatus: "active",
      subscriptionUpdatedAt: new Date("2026-08-16T09:00:00.000Z"),
      role: "user",
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    },
    {
      id: "new_owner",
      name: "New owner",
      email: "new@example.com",
      normalizedEmail: "new@example.com",
      plan: "organization",
      paddleCustomerId: "customer-new",
      paddleSubscriptionId: "subscription-new",
      subscriptionStatus: "active",
      subscriptionUpdatedAt: new Date("2026-08-16T09:00:00.000Z"),
      role: "user",
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    },
  ]);
  await db.insert(organizations).values({
    id: "org_1",
    name: "Acme",
    ownerId: "old_owner",
    plan: "organization",
    paddleCustomerId: "customer-old",
    paddleSubscriptionId: "subscription-old",
    subscriptionStatus: "active",
    licenseLimit: 25,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  });
  await db.insert(organizationMembers).values([
    {
      id: "member_old",
      organizationId: "org_1",
      userId: "old_owner",
      role: "admin",
      joinedAt: acceptedAt,
    },
    {
      id: "member_new",
      organizationId: "org_1",
      userId: "new_owner",
      role: "member",
      joinedAt: acceptedAt,
    },
  ]);

  paddleQuantities = new Map([["subscription-old", 2], ["subscription-new", 1]]);
  getSubscriptionMock.mockImplementation(async (_apiKey: string, subscriptionId: string) => ({
    id: subscriptionId,
    status: "active",
    customer_id: subscriptionId === "subscription-old" ? "customer-old" : "customer-new",
    updated_at: "2026-08-17T08:00:00.000Z",
    items: [{
      price: { id: "pri_01test000000000000000seat" },
      quantity: paddleQuantities.get(subscriptionId),
    }],
  }));
  updateSubscriptionQuantityMock.mockImplementation(
    async (_apiKey: string, subscriptionId: string, _priceId: string, quantity: number) => {
      paddleQuantities.set(subscriptionId, quantity);
    },
  );
});

describe("transferOrganizationBillingOwnership", () => {
  it("does not touch Paddle without an unexpired nomination accepted by the target", async () => {
    await expect(transferOrganizationBillingOwnership(db, env, {
      organizationId: "org_1",
      currentOwnerUserId: "old_owner",
      newOwnerUserId: "new_owner",
      now: acceptedAt,
    })).resolves.toBe(false);

    expect(getSubscriptionMock).not.toHaveBeenCalled();
    expect(updateSubscriptionQuantityMock).not.toHaveBeenCalled();
  });

  it("moves seat billing only after the nominated owner accepts", async () => {
    await db.insert(organizationOwnershipTransfers).values({
      organizationId: "org_1",
      requestedByUserId: "old_owner",
      proposedOwnerUserId: "new_owner",
      expiresAt: new Date("2026-08-18T09:00:00.000Z"),
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });

    await expect(transferOrganizationBillingOwnership(db, env, {
      organizationId: "org_1",
      currentOwnerUserId: "old_owner",
      newOwnerUserId: "new_owner",
      now: acceptedAt,
    })).resolves.toBe(true);

    expect(updateSubscriptionQuantityMock).toHaveBeenNthCalledWith(
      1,
      "test-key",
      "subscription-old",
      "pri_01test000000000000000seat",
      1,
    );
    expect(updateSubscriptionQuantityMock).toHaveBeenNthCalledWith(
      2,
      "test-key",
      "subscription-new",
      "pri_01test000000000000000seat",
      2,
    );
    await expect(db.query.organizations.findFirst({ where: { id: "org_1" } }))
      .resolves.toMatchObject({
        ownerId: "new_owner",
        paddleCustomerId: "customer-new",
        paddleSubscriptionId: "subscription-new",
        // The ceiling moves with the ownership swap and equals the quantity
        // actually applied to the incoming subscription (2 members → 2 seats),
        // so the next invitation (memberCount + 1) exceeds the stored limit and
        // purchases a seat instead of riding the previous owner's stale
        // headroom (the outgoing 25-seat limit).
        licenseLimit: 2,
      });
  });

  it("keeps the ceiling at the applied quantity when Paddle needed no seat change", async () => {
    await db.insert(organizationOwnershipTransfers).values({
      organizationId: "org_1",
      requestedByUserId: "old_owner",
      proposedOwnerUserId: "new_owner",
      expiresAt: new Date("2026-08-18T09:00:00.000Z"),
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    getSubscriptionMock.mockImplementation(async (_apiKey: string, subscriptionId: string) => ({
      id: subscriptionId,
      status: "active",
      customer_id: subscriptionId === "subscription-old" ? "customer-old" : "customer-new",
      updated_at: "2026-08-17T08:00:00.000Z",
      items: [{
        price: { id: "pri_01test000000000000000seat" },
        quantity: subscriptionId === "subscription-old" ? 3 : 2,
      }],
    }));

    await expect(transferOrganizationBillingOwnership(db, env, {
      organizationId: "org_1",
      currentOwnerUserId: "old_owner",
      newOwnerUserId: "new_owner",
      now: acceptedAt,
    })).resolves.toBe(true);

    // Only the outgoing subscription is lowered; the incoming one already
    // matches the member count, and the ceiling still lands on that quantity.
    expect(updateSubscriptionQuantityMock).toHaveBeenCalledTimes(1);
    expect(updateSubscriptionQuantityMock).toHaveBeenCalledWith(
      "test-key",
      "subscription-old",
      "pri_01test000000000000000seat",
      1,
    );
    await expect(db.query.organizations.findFirst({
      where: { id: "org_1" },
      columns: { licenseLimit: true },
    })).resolves.toEqual({ licenseLimit: 2 });
  });

  it("restores both subscriptions when the ownership update was fenced out", async () => {
    await db.insert(organizationOwnershipTransfers).values({
      organizationId: "org_1",
      requestedByUserId: "old_owner",
      proposedOwnerUserId: "new_owner",
      expiresAt: new Date("2026-08-18T09:00:00.000Z"),
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    await db.insert(users).values({
      id: "bystander",
      name: "Bystander",
      email: "bystander@example.com",
      normalizedEmail: "bystander@example.com",
      plan: "organization",
      role: "user",
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    // A write outside the Organization's scope (an account deletion, say)
    // moves the organization row between the reads and the guarded UPDATE, so
    // the ownership swap matches zero rows. The
    // mutation is chained onto the read the transfer awaits.
    const originalUsersRead = db.query.users.findFirst.bind(db.query.users);
    const usersSpy = vi.spyOn(db.query.users, "findFirst").mockImplementation((config) => {
      const read = originalUsersRead(config);
      void read.then(() => db.update(organizations)
        .set({ ownerId: "bystander" })
        .where(eq(organizations.id, "org_1")));
      return read;
    });

    try {
      await expect(transferOrganizationBillingOwnership(db, env, {
        organizationId: "org_1",
        currentOwnerUserId: "old_owner",
        newOwnerUserId: "new_owner",
        now: acceptedAt,
      })).resolves.toBe(false);
    } finally {
      usersSpy.mockRestore();
    }

    // The proven non-commit lowers both subscriptions back to their original
    // quantities: outgoing to 2, incoming to 1.
    expect(updateSubscriptionQuantityMock).toHaveBeenNthCalledWith(3,
      "test-key", "subscription-old", "pri_01test000000000000000seat", 2);
    expect(updateSubscriptionQuantityMock).toHaveBeenNthCalledWith(4,
      "test-key", "subscription-new", "pri_01test000000000000000seat", 1);
    await expect(db.query.organizations.findFirst({ where: { id: "org_1" } }))
      .resolves.toMatchObject({
        ownerId: "bystander",
        licenseLimit: 25,
        paddleSubscriptionId: "subscription-old",
      });
  });

  it("does not undo a seat change someone else made after this attempt's", async () => {
    await db.insert(organizationOwnershipTransfers).values({
      organizationId: "org_1",
      requestedByUserId: "old_owner",
      proposedOwnerUserId: "new_owner",
      expiresAt: new Date("2026-08-18T09:00:00.000Z"),
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    await db.insert(users).values({
      id: "bystander", name: "Bystander", email: "bystander@example.com",
      normalizedEmail: "bystander@example.com", plan: "organization", role: "user",
      createdAt: acceptedAt, updatedAt: acceptedAt,
    });
    // The swap is fenced out, as above.
    const originalUsersRead = db.query.users.findFirst.bind(db.query.users);
    const usersSpy = vi.spyOn(db.query.users, "findFirst").mockImplementation((config) => {
      const read = originalUsersRead(config);
      void read.then(() => db.update(organizations).set({ ownerId: "bystander" }).where(eq(organizations.id, "org_1")));
      return read;
    });
    // Right after this attempt raises the incoming subscription, its owner buys a seat.
    updateSubscriptionQuantityMock.mockImplementation(
      async (_apiKey: string, subscriptionId: string, _priceId: string, quantity: number) => {
        paddleQuantities.set(subscriptionId, quantity);
        if (subscriptionId === "subscription-new" && quantity === 2) paddleQuantities.set(subscriptionId, 3);
      },
    );

    try {
      await expect(transferOrganizationBillingOwnership(db, env, {
        organizationId: "org_1",
        currentOwnerUserId: "old_owner",
        newOwnerUserId: "new_owner",
        now: acceptedAt,
      })).resolves.toBe(false);
    } finally {
      usersSpy.mockRestore();
    }

    expect(paddleQuantities).toEqual(new Map([["subscription-old", 2], ["subscription-new", 3]]));
  });

  it("compensates billing when the probe proves the transfer never committed", async () => {
    await db.insert(organizationOwnershipTransfers).values({
      organizationId: "org_1",
      requestedByUserId: "old_owner",
      proposedOwnerUserId: "new_owner",
      expiresAt: new Date("2026-08-18T09:00:00.000Z"),
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    const callsBySubscription = new Map<string, number>();
    updateSubscriptionQuantityMock.mockImplementation(
      async (_apiKey: string, subscriptionId: string, _priceId: string, quantity: number) => {
        const seen = (callsBySubscription.get(subscriptionId) ?? 0) + 1;
        callsBySubscription.set(subscriptionId, seen);
        if (subscriptionId === "subscription-new" && seen === 1) {
          throw new Error("Paddle exploded");
        }
        paddleQuantities.set(subscriptionId, quantity);
      },
    );

    await expect(transferOrganizationBillingOwnership(db, env, {
      organizationId: "org_1",
      currentOwnerUserId: "old_owner",
      newOwnerUserId: "new_owner",
      now: acceptedAt,
    })).rejects.toThrow("Paddle exploded");

    // Once absence is proven, what this attempt changed is restored: the
    // outgoing subscription. The incoming one's change never landed, so
    // nothing is written to it.
    expect(updateSubscriptionQuantityMock).toHaveBeenCalledTimes(3);
    expect(updateSubscriptionQuantityMock).toHaveBeenNthCalledWith(3,
      "test-key", "subscription-old", "pri_01test000000000000000seat", 2);
    expect(paddleQuantities).toEqual(new Map([["subscription-old", 2], ["subscription-new", 1]]));
    await expect(db.query.organizations.findFirst({ where: { id: "org_1" } }))
      .resolves.toMatchObject({ ownerId: "old_owner", licenseLimit: 25 });
  });

  it("leaves billing untouched when the ownership state cannot be read after a failed update", async () => {
    await db.insert(organizationOwnershipTransfers).values({
      organizationId: "org_1",
      requestedByUserId: "old_owner",
      proposedOwnerUserId: "new_owner",
      expiresAt: new Date("2026-08-18T09:00:00.000Z"),
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    updateSubscriptionQuantityMock.mockImplementation(async (_apiKey: string, _subscriptionId: string) => {
      if (updateSubscriptionQuantityMock.mock.calls.length > 1) {
        throw new Error("Paddle exploded");
      }
    });
    const probeSpy = failProbeReadsById();

    await expect(transferOrganizationBillingOwnership(db, env, {
      organizationId: "org_1",
      currentOwnerUserId: "old_owner",
      newOwnerUserId: "new_owner",
      now: acceptedAt,
    })).rejects.toThrow("Paddle exploded");
    probeSpy.mockRestore();

    // An unreadable database is not proof the swap failed to commit, so no
    // rollback write happens; the attempt is logged for an operator.
    expect(updateSubscriptionQuantityMock).toHaveBeenCalledTimes(2);
    await expect(db.query.organizations.findFirst({ where: { id: "org_1" } }))
      .resolves.toMatchObject({ ownerId: "old_owner", licenseLimit: 25 });
  });

  it("leaves the quantities of an unreadable outcome for an operator", async () => {
    await db.insert(organizationOwnershipTransfers).values({
      organizationId: "org_1",
      requestedByUserId: "old_owner",
      proposedOwnerUserId: "new_owner",
      expiresAt: new Date("2026-08-18T09:00:00.000Z"),
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    await db.insert(users).values({
      id: "bystander",
      name: "Bystander",
      email: "bystander@example.com",
      normalizedEmail: "bystander@example.com",
      plan: "organization",
      role: "user",
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    const originalUsersRead = db.query.users.findFirst.bind(db.query.users);
    const usersSpy = vi.spyOn(db.query.users, "findFirst").mockImplementation((config) => {
      const read = originalUsersRead(config);
      void read.then(() => db.update(organizations)
        .set({ ownerId: "bystander" })
        .where(eq(organizations.id, "org_1")));
      return read;
    });
    const probeSpy = failProbeReadsById();

    try {
      await expect(transferOrganizationBillingOwnership(db, env, {
        organizationId: "org_1",
        currentOwnerUserId: "old_owner",
        newOwnerUserId: "new_owner",
        now: acceptedAt,
      })).resolves.toBe(false);
    } finally {
      probeSpy.mockRestore();
      usersSpy.mockRestore();
    }

    // The attempt cannot tell whether its swap committed, so it restores
    // nothing: the quantities stay as it set them.
    expect(updateSubscriptionQuantityMock).toHaveBeenCalledTimes(2);
    expect(paddleQuantities).toEqual(new Map([["subscription-old", 1], ["subscription-new", 2]]));
  });

  it("does not assign ownership after the recipient starts account deletion", async () => {
    await db.insert(organizationOwnershipTransfers).values({
      organizationId: "org_1",
      requestedByUserId: "old_owner",
      proposedOwnerUserId: "new_owner",
      expiresAt: new Date("2026-08-18T09:00:00.000Z"),
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    await db.update(users).set({ deletionStartedAt: acceptedAt })
      .where(eq(users.id, "new_owner"));

    await expect(transferOrganizationBillingOwnership(db, env, {
      organizationId: "org_1",
      currentOwnerUserId: "old_owner",
      newOwnerUserId: "new_owner",
      now: acceptedAt,
    })).resolves.toBe(false);
    expect(updateSubscriptionQuantityMock).not.toHaveBeenCalled();
  });
});

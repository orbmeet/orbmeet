import { beforeEach, describe, expect, it, vi } from "vitest";
import { organizationMembers, organizations, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedSubscription } from "@/test/billing";

const polar = vi.hoisted(() => ({
  getCustomerByExternalId: vi.fn(),
  findCustomerByEmail: vi.fn(),
  createIndividualCustomer: vi.fn(),
  createTeamCustomer: vi.fn(),
  setCustomerExternalId: vi.fn(),
  getMember: vi.fn(),
  createMember: vi.fn(),
  makeMemberOwner: vi.fn(),
  listMembers: vi.fn(),
  deleteMember: vi.fn(),
  createCheckout: vi.fn(),
  createPortalSession: vi.fn(),
}));
vi.mock("./polar", async (original) => ({
  ...await original<typeof import("./polar")>(),
  ...polar,
}));

import { openBillingPortal, prepareCheckout } from "./checkout.server";

const env = {
  POLAR_ACCESS_TOKEN: "t",
  POLAR_PRODUCT_ID_PRO: "11111111-1111-4111-8111-111111111111",
  POLAR_PRODUCT_ID_ORGANIZATION: "22222222-2222-4222-8222-222222222222",
  APP_URL: "https://app.example",
} as unknown as Env;

let db: TestDb;

const userCheckout = (userId: string, actorUserId = userId) => ({
  kind: "prepareCheckout" as const,
  customer: { kind: "user" as const, userId },
  actorUserId,
  customerIpAddress: null,
});
const organizationCheckout = (actorUserId: string) => ({
  kind: "prepareCheckout" as const,
  customer: { kind: "organization" as const, organizationId: "org_1" },
  actorUserId,
  customerIpAddress: "203.0.113.9",
});

beforeEach(async () => {
  db = await createTestDb();
  for (const mock of Object.values(polar)) mock.mockReset();
  polar.createCheckout.mockResolvedValue("https://polar.sh/checkout/co_1");
  polar.createPortalSession.mockResolvedValue("https://polar.sh/portal/s_1");
  polar.listMembers.mockResolvedValue([]);
  const now = new Date();
  await db.insert(users).values([
    { id: "ada", name: "Ada", email: "ada@example.com", normalizedEmail: "ada@example.com", role: "user", createdAt: now, updatedAt: now },
    { id: "bob", name: "Bob", email: "bob@example.com", normalizedEmail: "bob@example.com", role: "user", createdAt: now, updatedAt: now },
  ]);
  await db.insert(organizations).values({ id: "org_1", name: "Acme", ownerId: "ada", createdAt: now, updatedAt: now });
  await db.insert(organizationMembers).values([
    { id: "omb_ada", organizationId: "org_1", userId: "ada", role: "admin", joinedAt: now },
    { id: "omb_bob", organizationId: "org_1", userId: "bob", role: "member", joinedAt: now },
  ]);
});

describe("prepareCheckout", () => {
  it("creates the person's Polar customer first and links the checkout to it", async () => {
    polar.getCustomerByExternalId.mockResolvedValue(null);
    polar.findCustomerByEmail.mockResolvedValue(null);
    polar.createIndividualCustomer.mockResolvedValue({ id: "cus_ada", external_id: "user:ada", email: "ada@example.com" });

    await expect(prepareCheckout(db, env, userCheckout("ada")))
      .resolves.toEqual({ kind: "checkout", url: "https://polar.sh/checkout/co_1" });
    expect(polar.createIndividualCustomer).toHaveBeenCalledWith(expect.anything(), {
      externalId: "user:ada",
      email: "ada@example.com",
      name: "Ada",
    });
    expect(polar.createCheckout).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      customerId: "cus_ada",
      productId: env.POLAR_PRODUCT_ID_PRO,
      seats: undefined,
      successUrl: "https://app.example/settings?tab=plan-%26-billing&checkout={CHECKOUT_ID}",
    }));
  });

  it("claims a Polar customer that has the person's email but no account", async () => {
    polar.getCustomerByExternalId.mockResolvedValue(null);
    polar.findCustomerByEmail.mockResolvedValue({ id: "cus_dashboard", external_id: null, email: "ada@example.com" });

    await prepareCheckout(db, env, userCheckout("ada"));
    expect(polar.setCustomerExternalId).toHaveBeenCalledWith(expect.anything(), "cus_dashboard", "user:ada");
    expect(polar.createCheckout).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ customerId: "cus_dashboard" }));
  });

  it("never takes over a customer that belongs to another account", async () => {
    polar.getCustomerByExternalId.mockResolvedValue(null);
    polar.findCustomerByEmail.mockResolvedValue({ id: "cus_other", external_id: "user:someone", email: "ada@example.com" });

    await expect(prepareCheckout(db, env, userCheckout("ada"))).resolves.toEqual({ kind: "email_taken" });
    expect(polar.setCustomerExternalId).not.toHaveBeenCalled();
    expect(polar.createCheckout).not.toHaveBeenCalled();
  });

  it("sends a customer with a running subscription to the portal instead", async () => {
    await seedSubscription(db, { userId: "ada" }, { status: "past_due" });
    await expect(prepareCheckout(db, env, userCheckout("ada"))).resolves.toEqual({ kind: "subscription_exists" });
    expect(polar.createCheckout).not.toHaveBeenCalled();
  });

  it("allows a new checkout once the old subscription has ended", async () => {
    await seedSubscription(db, { userId: "ada" }, { status: "canceled" });
    polar.getCustomerByExternalId.mockResolvedValue({ id: "cus_ada", external_id: "user:ada", email: "ada@example.com" });
    await expect(prepareCheckout(db, env, userCheckout("ada"))).resolves.toMatchObject({ kind: "checkout" });
  });

  it("checks out an Organization as a team customer, for a seat per member", async () => {
    polar.getCustomerByExternalId.mockResolvedValue(null);
    polar.createTeamCustomer.mockResolvedValue({ id: "cus_org", external_id: "org:org_1", email: null });

    await expect(prepareCheckout(db, env, organizationCheckout("ada"))).resolves.toMatchObject({ kind: "checkout" });
    expect(polar.createTeamCustomer).toHaveBeenCalledWith(expect.anything(), {
      externalId: "org:org_1",
      name: "Acme",
      owner: { externalId: "user:ada", email: "ada@example.com", name: "Ada" },
    });
    expect(polar.createCheckout).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      customerId: "cus_org",
      productId: env.POLAR_PRODUCT_ID_ORGANIZATION,
      seats: 2,
      successUrl: "https://app.example/settings?tab=plan-%26-billing&checkoutOrganization=org_1&checkout={CHECKOUT_ID}",
      customerIpAddress: "203.0.113.9",
    }));
  });

  it("lets only the Organization's owner check it out", async () => {
    await expect(prepareCheckout(db, env, organizationCheckout("bob"))).resolves.toEqual({ kind: "forbidden" });
    await expect(prepareCheckout(db, env, userCheckout("ada", "bob"))).resolves.toEqual({ kind: "forbidden" });
    expect(polar.createCheckout).not.toHaveBeenCalled();
  });
});

describe("openBillingPortal", () => {
  it("opens an Organization's portal as its owner, after making them its only member", async () => {
    polar.getCustomerByExternalId.mockResolvedValue({ id: "cus_org", external_id: "org:org_1", email: null });
    polar.getMember.mockResolvedValue(null);
    polar.listMembers.mockResolvedValue([
      { id: "m1", external_id: "user:ada", role: "owner" },
      { id: "m0", external_id: "user:former_owner", role: "member" },
    ]);

    await expect(openBillingPortal(db, env, {
      customer: { kind: "organization", organizationId: "org_1" },
      actorUserId: "ada",
    })).resolves.toEqual({ kind: "portal", url: "https://polar.sh/portal/s_1" });
    expect(polar.createMember).toHaveBeenCalledWith(expect.anything(), "org:org_1", {
      externalId: "user:ada",
      email: "ada@example.com",
      name: "Ada",
    });
    expect(polar.makeMemberOwner).toHaveBeenCalledWith(expect.anything(), "org:org_1", "user:ada");
    expect(polar.deleteMember).toHaveBeenCalledExactlyOnceWith(expect.anything(), "org:org_1", "user:former_owner");
    expect(polar.createPortalSession).toHaveBeenCalledWith(expect.anything(), {
      customerExternalId: "org:org_1",
      memberExternalId: "user:ada",
      returnUrl: "https://app.example/settings?tab=plan-%26-billing",
    });
  });

  it("has nothing to open for a customer that never bought", async () => {
    polar.getCustomerByExternalId.mockResolvedValue(null);
    await expect(openBillingPortal(db, env, { customer: { kind: "user", userId: "bob" }, actorUserId: "bob" }))
      .resolves.toEqual({ kind: "no_billing_account" });
  });

  it("is the owner's alone for an Organization", async () => {
    await expect(openBillingPortal(db, env, {
      customer: { kind: "organization", organizationId: "org_1" },
      actorUserId: "bob",
    })).resolves.toEqual({ kind: "forbidden" });
  });
});

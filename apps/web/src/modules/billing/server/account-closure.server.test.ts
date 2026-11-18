import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@orbmeet/db";
import type { PolarSubscription } from "./polar-schema";

const polar = vi.hoisted(() => ({
  listCustomerSubscriptions: vi.fn(),
  revokeSubscription: vi.fn(),
  deleteCustomer: vi.fn(),
}));
vi.mock("./polar", async (original) => ({ ...await original<typeof import("./polar")>(), ...polar }));

import { closeUserBilling } from "./account-closure.server";
import { PolarApiError } from "./polar";

const env = { POLAR_ACCESS_TOKEN: "t" };
const db = {} as Database;

function subscription(id: string, status: string): PolarSubscription {
  return {
    id,
    status,
    product_id: "11111111-1111-4111-8111-111111111111",
    seats: null,
    cancel_at_period_end: false,
    current_period_end: null,
    created_at: "2026-11-01T00:00:00Z",
    modified_at: null,
    customer: { id: "cus_1", external_id: "user:ada" },
    pending_update: null,
  };
}

beforeEach(() => {
  for (const mock of Object.values(polar)) mock.mockReset().mockResolvedValue(undefined);
});

describe("closeUserBilling", () => {
  it("ends every subscription that has not ended, paused ones included, before deleting the customer", async () => {
    const calls: string[] = [];
    polar.listCustomerSubscriptions.mockResolvedValue([
      subscription("sub_active", "active"),
      subscription("sub_paused", "paused"),
      subscription("sub_past_due", "past_due"),
      subscription("sub_ended", "canceled"),
      subscription("sub_never_started", "incomplete_expired"),
    ]);
    polar.revokeSubscription.mockImplementation(async (_client, id: string) => void calls.push(`revoke ${id}`));
    polar.deleteCustomer.mockImplementation(async (_client, externalId: string) => void calls.push(`delete ${externalId}`));

    await closeUserBilling(db, env, "ada");

    expect(polar.listCustomerSubscriptions).toHaveBeenCalledWith(expect.anything(), "user:ada");
    expect(calls).toEqual([
      "revoke sub_active",
      "revoke sub_paused",
      "revoke sub_past_due",
      "delete user:ada",
    ]);
  });

  it("treats a subscription that ended meanwhile as done", async () => {
    polar.listCustomerSubscriptions.mockResolvedValue([subscription("sub_1", "active")]);
    polar.revokeSubscription.mockRejectedValue(new PolarApiError(403, "AlreadyCanceledSubscription", "ended"));

    await expect(closeUserBilling(db, env, "ada")).resolves.toBeUndefined();
    expect(polar.deleteCustomer).toHaveBeenCalledOnce();
  });

  it("deletes nothing when a subscription could not be ended, so a retry starts over", async () => {
    polar.listCustomerSubscriptions.mockResolvedValue([subscription("sub_1", "active")]);
    polar.revokeSubscription.mockRejectedValue(new PolarApiError(503, null, "unavailable"));

    await expect(closeUserBilling(db, env, "ada")).rejects.toThrow(PolarApiError);
    expect(polar.deleteCustomer).not.toHaveBeenCalled();
  });
});

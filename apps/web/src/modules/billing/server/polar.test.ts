import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCheckout,
  deleteCustomer,
  getSubscription,
  isPolarNotFound,
  listCustomerSubscriptions,
  listSubscriptionsByStatus,
  POLAR_API_VERSION,
  PolarApiError,
  polarClientFromEnv,
  seatChangeRefusal,
  updateSubscriptionSeats,
  type PolarClient,
} from "./polar";

afterEach(() => {
  vi.unstubAllGlobals();
});

const client: PolarClient = { accessToken: "polar_oat_test", baseUrl: "https://sandbox-api.polar.sh" };

const subscription = {
  id: "sub_1",
  status: "active",
  product_id: "11111111-1111-4111-8111-111111111111",
  seats: 3,
  cancel_at_period_end: false,
  current_period_end: "2026-12-01T00:00:00Z",
  created_at: "2026-11-01T00:00:00Z",
  modified_at: "2026-11-02T00:00:00.123456Z",
  customer: { id: "cus_1", external_id: "org:org_1" },
  pending_update: null,
};

function stubFetch(...responses: Array<{ status?: number; body?: unknown }>) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const { status = 200, body } of responses) {
    fetchMock.mockResolvedValueOnce(
      new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status }),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>, call = 0): unknown {
  return JSON.parse(String(fetchMock.mock.calls[call][1]?.body));
}

describe("polarClientFromEnv", () => {
  it("is off without a token", () => {
    expect(polarClientFromEnv({})).toBeNull();
  });

  it("points at the server configured beside the token", () => {
    expect(polarClientFromEnv({ POLAR_ACCESS_TOKEN: "t" })?.baseUrl).toBe("https://api.polar.sh");
    expect(polarClientFromEnv({ POLAR_ACCESS_TOKEN: "t", POLAR_SERVER: "sandbox" })?.baseUrl)
      .toBe("https://sandbox-api.polar.sh");
  });

  it("turns billing off rather than guess at a misspelled server", () => {
    expect(polarClientFromEnv({ POLAR_ACCESS_TOKEN: "t", POLAR_SERVER: "prod" })).toBeNull();
  });
});

describe("not found", () => {
  it("is only Polar's own ResourceNotFound", async () => {
    stubFetch({ status: 404, body: { error: "ResourceNotFound", detail: "Not found" } });
    await expect(getSubscription(client, "sub_1")).resolves.toBeNull();
  });

  it("is not the 404 a removed API version answers with", async () => {
    // What Polar's version middleware sends once POLAR_API_VERSION is retired.
    stubFetch({ status: 404, body: { detail: "Not Found" } });
    const error = await getSubscription(client, "sub_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PolarApiError);
    expect(isPolarNotFound(error)).toBe(false);
  });

  it("lets a customer deletion succeed only when the customer is really gone", async () => {
    stubFetch({ status: 404, body: { error: "ResourceNotFound", detail: "Not found" } });
    await expect(deleteCustomer(client, "user:u1")).resolves.toBeUndefined();

    stubFetch({ status: 404, body: { detail: "Not Found" } });
    await expect(deleteCustomer(client, "user:u1")).rejects.toBeInstanceOf(PolarApiError);
  });
});

describe("requests", () => {
  it("pins the API version and sends the token", async () => {
    const fetchMock = stubFetch({ body: subscription });
    await getSubscription(client, "sub_1");
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["Polar-Version"]).toBe(POLAR_API_VERSION);
    expect(headers.Authorization).toBe("Bearer polar_oat_test");
  });

  it("links a checkout to the customer by id, so its email cannot be changed", async () => {
    const fetchMock = stubFetch({ body: { id: "co_1", url: "https://polar.sh/checkout/co_1" } });
    await expect(createCheckout(client, {
      customerId: "cus_1",
      productId: "prod_1",
      seats: 4,
      successUrl: "https://app/settings?checkout={CHECKOUT_ID}",
      returnUrl: "https://app/settings",
    })).resolves.toBe("https://polar.sh/checkout/co_1");
    expect(sentBody(fetchMock)).toEqual({
      products: ["prod_1"],
      customer_id: "cus_1",
      seats: 4,
      min_seats: 4,
      max_seats: 4,
      success_url: "https://app/settings?checkout={CHECKOUT_ID}",
      return_url: "https://app/settings",
    });
  });

  it("sets seats with the proration asked for and returns the updated subscription", async () => {
    const fetchMock = stubFetch({ body: { ...subscription, seats: 2 } });
    await expect(updateSubscriptionSeats(client, "sub_1", 2, "next_period"))
      .resolves.toMatchObject({ id: "sub_1", seats: 2 });
    expect(sentBody(fetchMock)).toEqual({ seats: 2, proration_behavior: "next_period" });
  });

  it("lists subscriptions by status, never by the deprecated `active` filter", async () => {
    const fetchMock = stubFetch({ body: { items: [subscription], pagination: { total_count: 1, max_page: 1 } } });
    await expect(listSubscriptionsByStatus(client, ["active", "past_due"], 1))
      .resolves.toMatchObject({ subscriptions: [{ id: "sub_1" }], lastPage: true });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/subscriptions/");
    expect(url.searchParams.getAll("status")).toEqual(["active", "past_due"]);
    expect(url.searchParams.has("active")).toBe(false);
  });

  it("lists every subscription of one customer, by external id", async () => {
    const fetchMock = stubFetch({ body: { items: [subscription], pagination: { total_count: 1, max_page: 1 } } });
    await expect(listCustomerSubscriptions(client, "user:ada")).resolves.toMatchObject([{ id: "sub_1" }]);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("external_customer_id")).toBe("user:ada");
    expect(url.searchParams.has("status")).toBe(false);
  });

  it("refuses a zero seat count before calling Polar", async () => {
    const fetchMock = stubFetch();
    await expect(updateSubscriptionSeats(client, "sub_1", 0, "invoice")).rejects.toThrow("positive integer");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("seatChangeRefusal", () => {
  it.each([
    [402, "PaymentFailed", "payment_failed"],
    [402, "PaymentActionRequired", "payment_failed"],
    [403, "AlreadyCanceledSubscription", "not_active"],
    [403, "InactiveSubscription", "not_active"],
    [403, "PaymentNotReady", "not_active"],
    [422, "AboveMaximumSeats", "above_maximum"],
    [422, "BelowMinimumSeats", "below_floor"],
    [422, "SeatsAlreadyAssigned", "below_floor"],
  ] as const)("reads a %i %s as %s", (status, code, refusal) => {
    expect(seatChangeRefusal(new PolarApiError(status, code, "x"))).toBe(refusal);
  });

  it("goes by Polar's error code, not the HTTP status", () => {
    expect(seatChangeRefusal(new PolarApiError(403, null, "x"))).toBeNull();
    expect(seatChangeRefusal(new PolarApiError(422, "RequestValidationError", "x"))).toBeNull();
  });

  it("leaves everything else to the caller", () => {
    expect(seatChangeRefusal(new PolarApiError(500, null, "x"))).toBeNull();
    expect(seatChangeRefusal(new Error("network"))).toBeNull();
  });
});

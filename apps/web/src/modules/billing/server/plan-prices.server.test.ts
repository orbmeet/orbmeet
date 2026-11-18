import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPlanPricesCache, resolvePlanPrices } from "./plan-prices.server";

const PRO = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION = "22222222-2222-4222-8222-222222222222";
const env = { POLAR_ACCESS_TOKEN: "t", POLAR_PRODUCT_ID_PRO: PRO, POLAR_PRODUCT_ID_ORGANIZATION: ORGANIZATION };

const fixed = (currency: string, amount: number, archived = false) =>
  ({ amount_type: "fixed", price_currency: currency, is_archived: archived, price_amount: amount });
const seat = (currency: string, perSeat: number) =>
  ({ amount_type: "seat_based", price_currency: currency, is_archived: false, seat_tiers: { tiers: [{ price_per_seat: perSeat }] } });

const catalog: Record<string, unknown[]> = {
  [PRO]: [fixed("usd", 500), fixed("eur", 500), fixed("bdt", 60000), fixed("inr", 45000), fixed("gbp", 999, true)],
  [ORGANIZATION]: [seat("usd", 1000), seat("bdt", 120000), seat("inr", 90000)],
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  resetPlanPricesCache();
  fetchMock.mockReset().mockImplementation(async (input) => {
    const id = String(input).split("/v1/products/")[1];
    return new Response(JSON.stringify({ id, prices: catalog[id] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolvePlanPrices", () => {
  it("charges a visitor in their country's currency where the product has a price in it", async () => {
    await expect(resolvePlanPrices(env, "BD")).resolves.toEqual({
      pro: { currency: "bdt", amount: 600 },
      organizationSeat: { currency: "bdt", amount: 1200 },
      taxAddedAtCheckout: false,
    });
  });

  it("picks each product's currency on its own, as Polar does", async () => {
    // Germany: Pro has a euro price, the Organization plan does not.
    await expect(resolvePlanPrices(env, "DE")).resolves.toMatchObject({
      pro: { currency: "eur", amount: 5 },
      organizationSeat: { currency: "usd", amount: 10 },
    });
  });

  it("falls back to the default currency for an unpriced or unknown country", async () => {
    const usd = { pro: { currency: "usd", amount: 5 }, organizationSeat: { currency: "usd", amount: 10 } };
    await expect(resolvePlanPrices(env, "JP")).resolves.toMatchObject(usd);
    await expect(resolvePlanPrices(env, null)).resolves.toMatchObject(usd);
  });

  it("ignores archived prices", async () => {
    // The UK's only GBP price is archived.
    await expect(resolvePlanPrices(env, "GB")).resolves.toMatchObject({ pro: { currency: "usd", amount: 5 } });
  });

  it("says where tax is added on top", async () => {
    await expect(resolvePlanPrices(env, "IN")).resolves.toMatchObject({
      pro: { currency: "inr", amount: 450 },
      taxAddedAtCheckout: true,
    });
    await expect(resolvePlanPrices(env, "US")).resolves.toMatchObject({ taxAddedAtCheckout: true });
    await expect(resolvePlanPrices(env, "FR")).resolves.toMatchObject({ taxAddedAtCheckout: false });
  });

  it("reads Polar once per cache period, not per visitor", async () => {
    const now = Date.now();
    await resolvePlanPrices(env, "BD", now);
    await resolvePlanPrices(env, "IN", now + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2); // one read of each product
    await resolvePlanPrices(env, "IN", now + 11 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps showing the last prices it read while Polar is unreachable", async () => {
    const now = Date.now();
    await resolvePlanPrices(env, "BD", now);
    fetchMock.mockRejectedValue(new Error("network"));
    await expect(resolvePlanPrices(env, "BD", now + 11 * 60_000)).resolves.toMatchObject({
      pro: { currency: "bdt", amount: 600 },
    });
  });

  it("shows the default prices, and never fails, when Polar cannot be read at all", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));
    await expect(resolvePlanPrices(env, "BD")).resolves.toEqual({
      pro: { currency: "usd", amount: 5 },
      organizationSeat: { currency: "usd", amount: 10 },
      taxAddedAtCheckout: false,
    });
    await expect(resolvePlanPrices(null, "BD")).resolves.toMatchObject({ pro: { currency: "usd", amount: 5 } });
  });

  it("reads zero-decimal currencies as whole units", async () => {
    catalog[PRO] = [fixed("usd", 500), fixed("jpy", 800)];
    try {
      await expect(resolvePlanPrices(env, "JP")).resolves.toMatchObject({ pro: { currency: "jpy", amount: 800 } });
    } finally {
      catalog[PRO] = [fixed("usd", 500), fixed("eur", 500), fixed("bdt", 60000), fixed("inr", 45000), fixed("gbp", 999, true)];
    }
  });
});

import "@tanstack/react-start/server-only";

import { logWarn } from "@/lib/logger";
import type { PaidSubscriptionTier } from "@/modules/billing/contract/types";
import { DEFAULT_PLAN_PRICES, type PlanPrice, type PlanPrices } from "@/modules/billing/contract/plan-prices";
import { COUNTRY_CURRENCIES } from "./country-currencies";
import { getProduct, polarClientFromEnv } from "./polar";
import { polarProductIdForPlan, type PolarCatalogConfig } from "./polar-config";
import type { PolarProduct } from "./polar-schema";

/**
 * The prices a visitor will be charged, read from the Polar products
 * themselves so the site never disagrees with checkout. The currency follows
 * Polar's own rule: the visitor's country's currency where the product has a
 * price in it, else the organization's default.
 */

/** The Polar organization's default currency (Settings → Payments). */
const DEFAULT_CURRENCY = DEFAULT_PLAN_PRICES.pro.currency;

/** When Polar cannot be read and nothing is cached yet. */
const FALLBACK: Record<PaidSubscriptionTier, PlanPrice> = {
  pro: DEFAULT_PLAN_PRICES.pro,
  organization: DEFAULT_PLAN_PRICES.organizationSeat,
};

/**
 * Where Polar's location-based tax behaviour adds tax on top of the price;
 * everywhere else it is included.
 */
const TAX_ADDED_COUNTRIES = new Set(["US", "CA", "IN"]);

/** Polar's (and Stripe's) currencies with no minor unit. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf",
]);

const FRESH_MS = 10 * 60 * 1000;
/** A stale catalog beats the fallback while Polar is unreachable. */
const STALE_MS = 24 * 60 * 60 * 1000;

/** Each plan's prices by currency, in the currency's smallest unit. */
type Catalog = Record<PaidSubscriptionTier, Map<string, number>>;

/**
 * The last catalog read, shared by every request this isolate serves. Only
 * the data is shared: each request that needs a read makes its own, since a
 * Worker request may not wait on I/O another request started (it is bound to
 * that request, and is cancelled with it).
 */
let cached: { catalog: Catalog; readAt: number } | null = null;

function pricesByCurrency(product: PolarProduct): Map<string, number> {
  const prices = new Map<string, number>();
  for (const price of product.prices) {
    if (price.is_archived) continue;
    const amount = price.amount_type === "fixed"
      ? price.price_amount
      : price.amount_type === "seat_based"
        ? price.seat_tiers?.tiers[0]?.price_per_seat
        : null;
    if (typeof amount === "number") prices.set(price.price_currency.toLowerCase(), amount);
  }
  return prices;
}

async function readCatalog(env: PolarCatalogConfig & { POLAR_ACCESS_TOKEN?: string; POLAR_SERVER?: string }): Promise<Catalog | null> {
  const client = polarClientFromEnv(env);
  const proId = polarProductIdForPlan(env, "pro");
  const organizationId = polarProductIdForPlan(env, "organization");
  if (!client || !proId || !organizationId) return null;
  const [pro, organization] = await Promise.all([getProduct(client, proId), getProduct(client, organizationId)]);
  if (!pro || !organization) throw new Error("A configured Polar product does not exist");
  return { pro: pricesByCurrency(pro), organization: pricesByCurrency(organization) };
}

async function loadCatalog(env: Parameters<typeof readCatalog>[0], now: number): Promise<Catalog | null> {
  if (cached && now - cached.readAt < FRESH_MS) return cached.catalog;
  const fresh = await readCatalog(env).catch((error: unknown) => {
    logWarn("[billing] Could not read plan prices from Polar; showing the last known ones", error);
    return null;
  });
  if (fresh) {
    cached = { catalog: fresh, readAt: Date.now() };
    return fresh;
  }
  return cached && now - cached.readAt < STALE_MS ? cached.catalog : null;
}

function toMajorUnits(currency: string, amount: number): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? amount : amount / 100;
}

function priceFor(catalog: Catalog | null, plan: PaidSubscriptionTier, country: string | null): PlanPrice {
  const prices = catalog?.[plan];
  const local = country ? COUNTRY_CURRENCIES[country] : undefined;
  for (const currency of [local, DEFAULT_CURRENCY]) {
    const amount = currency ? prices?.get(currency) : undefined;
    if (currency && amount !== undefined) return { currency, amount: toMajorUnits(currency, amount) };
  }
  return FALLBACK[plan];
}

/** The prices a visitor from `country` (ISO 3166-1 alpha-2, or null) will be charged. */
export async function resolvePlanPrices(
  env: Parameters<typeof readCatalog>[0] | null,
  country: string | null,
  now = Date.now(),
): Promise<PlanPrices> {
  const catalog = env ? await loadCatalog(env, now) : null;
  return {
    pro: priceFor(catalog, "pro", country),
    organizationSeat: priceFor(catalog, "organization", country),
    taxAddedAtCheckout: country !== null && TAX_ADDED_COUNTRIES.has(country),
  };
}

/** Forget the cached catalog. Tests only. */
export function resetPlanPricesCache(): void {
  cached = null;
}

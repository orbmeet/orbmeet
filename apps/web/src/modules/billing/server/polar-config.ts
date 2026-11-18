import type { PaidSubscriptionTier } from "@/modules/billing/contract/types";

/**
 * Polar product ids are UUIDs. Anything else is a typo or a leftover
 * placeholder, and treating it as configured is worse than treating it as
 * absent: the id reaches Polar, which rejects the checkout with a 422 the user
 * sees as a generic failure. A runtime shape check turns that into the honest
 * "Plan pricing not configured" 503.
 */
const POLAR_PRODUCT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Polar catalog: one recurring product per paid plan. */
export interface PolarCatalogConfig {
  POLAR_PRODUCT_ID_PRO?: string;
  /** Seat-based: one seat per active Organization member. */
  POLAR_PRODUCT_ID_ORGANIZATION?: string;
}

/** Return a usable product id, never a placeholder or a malformed one. */
function configuredPolarProductId(value?: string): string | undefined {
  const productId = value?.trim();
  if (!productId || !POLAR_PRODUCT_ID_PATTERN.test(productId)) return undefined;
  return productId.toLowerCase();
}

export function polarProductIdForPlan(
  env: PolarCatalogConfig,
  plan: PaidSubscriptionTier,
): string | undefined {
  return configuredPolarProductId(
    plan === "pro" ? env.POLAR_PRODUCT_ID_PRO : env.POLAR_PRODUCT_ID_ORGANIZATION,
  );
}

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import { resolvePlanPrices } from "./plan-prices.server";

interface CloudflareRequest extends Request {
  cf?: { country?: string };
}

/**
 * The plan prices this visitor will be charged, in their checkout currency.
 * Public: the pricing page shows them before anyone signs in. The country is
 * Cloudflare's, the same location Polar's checkout uses (billing forwards the
 * visitor's IP to it).
 */
export const getPlanPrices = createServerFn({ method: "GET" }).handler(async () => {
  const country = (getRequest() as CloudflareRequest).cf?.country;
  return resolvePlanPrices(
    (await getOptionalEnv()) ?? null,
    country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
  );
});

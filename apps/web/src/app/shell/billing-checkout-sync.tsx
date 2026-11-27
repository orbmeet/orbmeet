import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { myOrganizationsQueryOptions } from "@/modules/organizations/client/organizations.queries";
import { sessionQueryOptions } from "@/modules/identity/client/session.queries";
import { consumeCheckoutReturn, type CheckoutReturn } from "@/modules/billing/client/checkout-return";

const PROJECTION_RETRY_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000, 8_000] as const;

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The query that shows what was bought, and whether it has landed: whether
 * the plan bought is granted, in the person's session for Pro or their
 * Organizations for an Organization's plan. A subscription that exists but
 * grants nothing yet (Polar's `incomplete`, stored a moment before it is
 * activated) has not landed.
 */
function checkoutProjection(queryClient: QueryClient, checkout: CheckoutReturn) {
  const { organizationId } = checkout;
  if (organizationId) {
    const options = myOrganizationsQueryOptions();
    return {
      queryKey: options.queryKey,
      landed: async () => {
        const data = await queryClient.fetchQuery({ ...options, staleTime: 0 });
        return data.organizations.some(
          (organization) => organization.id === organizationId && organization.billing.plan === "organization",
        );
      },
    };
  }
  const options = sessionQueryOptions();
  return {
    queryKey: options.queryKey,
    landed: async () => {
      const session = await queryClient.fetchQuery({ ...options, staleTime: 0 });
      return session?.user?.plan === "pro";
    },
  };
}

/**
 * Bridge the return from Polar's hosted checkout to the webhook-owned
 * subscription projection. The redirect back is immediate, while the signed
 * webhook is eventually delivered. Re-fetch until that authoritative
 * projection becomes visible, then leave the cache coherent for every plan
 * badge and entitlement.
 */
// Read once per page load (undefined until then): the markers leave the URL
// as they are read, and a re-run effect (StrictMode, a remount) must still
// finish the convergence.
let pendingCheckoutReturn: CheckoutReturn | null | undefined;

export function BillingCheckoutSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (pendingCheckoutReturn === undefined) pendingCheckoutReturn = consumeCheckoutReturn();
    const checkout = pendingCheckoutReturn;
    if (!checkout) return;
    const controller = new AbortController();
    const projection = checkoutProjection(queryClient, checkout);

    void (async () => {
      try {
        for (const delayMs of PROJECTION_RETRY_DELAYS_MS) {
          await waitForDelay(delayMs, controller.signal);
          if (controller.signal.aborted) return;
          await queryClient.invalidateQueries({ queryKey: projection.queryKey, refetchType: "none" });
          if (await projection.landed()) break;
        }
      } finally {
        if (!controller.signal.aborted) {
          pendingCheckoutReturn = null;
          // If the webhook exceeded the bounded convergence window, keep the
          // cache stale so focus/navigation retries instead of freezing Free.
          await queryClient.invalidateQueries({ queryKey: projection.queryKey, refetchType: "none" });
        }
      }
    })();

    return () => controller.abort();
  }, [queryClient]);

  return null;
}

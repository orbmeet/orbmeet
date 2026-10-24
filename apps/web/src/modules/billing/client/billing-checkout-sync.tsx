import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import { subscribeToPaddleCheckoutCompletion } from "./paddle-checkout";

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
 * Bridge Paddle's browser event to the webhook-owned subscription projection.
 * Checkout success is immediate, while the signed webhook is eventually
 * delivered. Re-fetch until that authoritative projection becomes visible,
 * then leave the session cache coherent for every plan badge and entitlement.
 */
export function BillingCheckoutSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let currentRefresh: AbortController | null = null;
    const unsubscribe = subscribeToPaddleCheckoutCompletion(() => {
      currentRefresh?.abort();
      const controller = new AbortController();
      currentRefresh = controller;

      void (async () => {
        const options = sessionQueryOptions();
        try {
          for (const delayMs of PROJECTION_RETRY_DELAYS_MS) {
            await waitForDelay(delayMs, controller.signal);
            if (controller.signal.aborted) return;
            await queryClient.invalidateQueries({
              queryKey: options.queryKey,
              refetchType: "none",
            });
            const session = await queryClient.fetchQuery({
              ...options,
              staleTime: 0,
            });
            if (session?.user?.hasManagedSubscription) return;
          }
        } finally {
          // If the webhook exceeded the bounded convergence window, keep the
          // cache stale so focus/navigation retries instead of freezing Free.
          if (!controller.signal.aborted) {
            await queryClient.invalidateQueries({
              queryKey: options.queryKey,
              refetchType: "none",
            });
          }
        }
      })();
    });

    return () => {
      currentRefresh?.abort();
      unsubscribe();
    };
  }, [queryClient]);

  return null;
}

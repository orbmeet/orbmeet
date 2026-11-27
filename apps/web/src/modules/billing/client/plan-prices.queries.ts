import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { getPlanPrices } from "@/modules/billing/server/plan-prices.functions";

/** The plan prices this visitor will be charged, in their checkout currency. */
export const planPricesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.planPrices(),
    queryFn: ({ signal }) => getPlanPrices({ signal }),
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });

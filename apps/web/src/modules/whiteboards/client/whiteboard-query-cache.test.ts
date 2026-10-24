import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "@/app/query-client/query-keys";

describe("Whiteboard query-key boundaries", () => {
  it("refreshing the document list does not invalidate active access authority", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const accessKey = queryKeys.whiteboards.standaloneAccess("whiteboard_1");
    let accessFetches = 0;
    queryClient.setQueryData(accessKey, { token: "existing" });
    const observer = new QueryObserver(queryClient, {
      queryKey: accessKey,
      queryFn: async () => ({ token: `refetched-${++accessFetches}` }),
      staleTime: 30 * 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});

    try {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.whiteboards.list(),
      });

      expect(accessFetches).toBe(0);
      expect(queryClient.getQueryData(accessKey)).toEqual({ token: "existing" });
      expect(queryClient.getQueryState(accessKey)?.isInvalidated).toBe(false);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});

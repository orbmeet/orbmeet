import { describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/query-keys";
import { STATUS_REFRESH_INTERVAL_MS, uptimeStatusQueryOptions } from "./status.queries";

describe("uptimeStatusQueryOptions", () => {
  it("uses the shared status cache key", () => {
    expect(uptimeStatusQueryOptions().queryKey).toEqual(queryKeys.status());
  });

  it("polls once per minute", () => {
    const options = uptimeStatusQueryOptions();

    expect(options.refetchInterval).toBe(STATUS_REFRESH_INTERVAL_MS);
    expect(options.staleTime).toBe(30_000);
  });
});

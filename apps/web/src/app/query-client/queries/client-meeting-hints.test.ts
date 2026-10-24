import { describe, expect, it } from "vitest";
import { queryKeys } from "@/app/query-client/query-keys";
import { clientMeetingHintsQueryOptions } from "./client-meeting-hints";

describe("clientMeetingHintsQueryOptions", () => {
  it("shares one cache entry across meeting surfaces", () => {
    expect(clientMeetingHintsQueryOptions().queryKey).toEqual(queryKeys.clientMeetingHints());
  });

  it("keeps request-derived hints for the browser session", () => {
    const options = clientMeetingHintsQueryOptions();

    expect(options.staleTime).toBe(30 * 60 * 1000);
    expect(options.gcTime).toBe(60 * 60 * 1000);
  });
});

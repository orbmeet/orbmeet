import { describe, expect, it } from "vitest";
import { queryKeys } from "@/app/query-client/query-keys";
import { recordingPlaybackQueryOptions } from "./artifacts";

describe("recordingPlaybackQueryOptions", () => {
  it("keys signed playback URLs by artifact", () => {
    const first = recordingPlaybackQueryOptions("artifact-1");
    const second = recordingPlaybackQueryOptions("artifact-2");

    expect(first.queryKey).toEqual(queryKeys.artifacts.recordingPlayback("artifact-1"));
    expect(second.queryKey).toEqual(queryKeys.artifacts.recordingPlayback("artifact-2"));
    expect(first.queryKey).not.toEqual(second.queryKey);
  });

  it("marks playback URLs stale before their one-hour signature expires", () => {
    const options = recordingPlaybackQueryOptions("artifact-1");

    expect(options.staleTime).toBe(50 * 60 * 1000);
    expect(options.gcTime).toBe(60 * 60 * 1000);
  });
});

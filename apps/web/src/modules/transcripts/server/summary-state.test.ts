import { describe, expect, it } from "vitest";
import { summaryStateOf } from "./summary-state";

const base = { hasCurrentSummary: false, summarySkipReason: null, configured: true } as const;

describe("summaryStateOf", () => {
  it("is ready whenever a Summary of the transcript as it stands exists", () => {
    expect(summaryStateOf({ ...base, hasCurrentSummary: true, summaryStatus: "pending" }))
      .toEqual({ status: "ready" });
  });

  it("follows the summary job while it owes or gave up on a Summary", () => {
    expect(summaryStateOf({ ...base, summaryStatus: "pending" })).toEqual({ status: "pending" });
    expect(summaryStateOf({ ...base, summaryStatus: "failed" })).toEqual({ status: "failed" });
  });

  it("reports why a settled Summary has no text", () => {
    expect(summaryStateOf({ ...base, summaryStatus: "settled", summarySkipReason: "transcript_too_large" }))
      .toEqual({ status: "skipped", reason: "transcript_too_large" });
  });

  it("explains a meeting that was never owed a Summary", () => {
    expect(summaryStateOf({ ...base, summaryStatus: null }))
      .toEqual({ status: "skipped", reason: "no_transcript" });
    expect(summaryStateOf({ ...base, summaryStatus: null, configured: false }))
      .toEqual({ status: "skipped", reason: "ai_not_configured" });
  });
});

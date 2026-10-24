import type { MEETING_SUMMARY_SKIP_REASONS, MEETING_SUMMARY_STATUSES } from "@orbmeet/domain-model";

export type SummarySkipReason = (typeof MEETING_SUMMARY_SKIP_REASONS)[number];

/**
 * Where an ended Meeting's Summary stands for its current transcript. The
 * meeting's summary job is the only writer; both summary pages read this.
 */
export type SummaryState =
  | { status: "ready" }
  | { status: "pending" }
  | { status: "failed" }
  | { status: "skipped"; reason: SummarySkipReason };

export function summaryStateOf(input: {
  /** A Summary written for the transcript as it stands now. */
  hasCurrentSummary: boolean;
  summaryStatus: (typeof MEETING_SUMMARY_STATUSES)[number] | null;
  summarySkipReason: SummarySkipReason | null;
  /** Whether summaries are configured at all. */
  configured: boolean;
}): SummaryState {
  if (input.hasCurrentSummary) return { status: "ready" };
  switch (input.summaryStatus) {
    case "pending":
      return { status: "pending" };
    case "failed":
      return { status: "failed" };
    case "settled":
      return { status: "skipped", reason: input.summarySkipReason ?? "no_transcript" };
    case null:
      // No Summary was owed when the meeting ended.
      return { status: "skipped", reason: input.configured ? "no_transcript" : "ai_not_configured" };
  }
}

export const ENTRY_METRICS_STORAGE_KEY = "orbmeet.meeting-entry-metrics.v1";

export type EntryMetricKey =
  | "intentAt"
  | "routeMountedAt"
  | "prejoinReadyAt"
  | "joinRequestedAt"
  | "joinCredentialsReadyAt"
  | "liveKitConnectedAt"
  | "whiteboardRequestedAt"
  | "whiteboardReadyAt";

export type EntryMetricsState = Partial<Record<EntryMetricKey, number>> & {
  code?: string;
  source?: string;
  flowId?: string;
  loggedStages?: string[];
};

export function writeEntryMetricsState(state: EntryMetricsState): void {
  try {
    window.sessionStorage.setItem(ENTRY_METRICS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures.
  }
}

export function beginMeetingEntryFlow(options: { code?: string; source: string }): void {
  const now = Date.now();
  const state: EntryMetricsState = {
    flowId: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    source: options.source,
    code: options.code,
    intentAt: now,
    loggedStages: [],
  };

  writeEntryMetricsState(state);
}

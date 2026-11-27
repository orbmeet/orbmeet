import {
  beginMeetingEntryFlow,
  ENTRY_METRICS_STORAGE_KEY,
  writeEntryMetricsState,
  type EntryMetricKey,
  type EntryMetricsState,
} from "@/lib/telemetry/meeting-entry-flow";
import { emitMeetingEntryDiagnostic } from "./entry/diagnostics";

export { beginMeetingEntryFlow };

const STALE_AFTER_MS = 10 * 60 * 1000;

function now() {
  return Date.now();
}

// Storage is touched only inside `try`: where a browser blocks site data,
// reading `window.sessionStorage` itself throws, and timing a join must never
// be what stops one.
function readState(): EntryMetricsState | null {
  try {
    const raw = window.sessionStorage.getItem(ENTRY_METRICS_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as EntryMetricsState;
    const freshestTimestamp = Math.max(
      parsed.intentAt ?? 0,
      parsed.routeMountedAt ?? 0,
      parsed.prejoinReadyAt ?? 0,
      parsed.joinRequestedAt ?? 0,
      parsed.joinCredentialsReadyAt ?? 0,
      parsed.liveKitConnectedAt ?? 0,
      parsed.whiteboardRequestedAt ?? 0,
      parsed.whiteboardReadyAt ?? 0,
    );

    if (!freshestTimestamp || now() - freshestTimestamp > STALE_AFTER_MS) {
      window.sessionStorage.removeItem(ENTRY_METRICS_STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function getState() {
  return readState() ?? {
    flowId: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
    loggedStages: [],
  };
}

function duration(from?: number, to?: number) {
  if (!from || !to || to < from) return null;
  return to - from;
}

function emitStage(stage: "livekit" | "whiteboard", state: EntryMetricsState) {
  const loggedStages = new Set(state.loggedStages ?? []);
  if (loggedStages.has(stage)) return;

  loggedStages.add(stage);
  state.loggedStages = [...loggedStages];
  writeEntryMetricsState(state);

  emitMeetingEntryDiagnostic("meeting_entry_timing", {
    stage,
    flowId: state.flowId,
    source: state.source,
    intent_to_route_ms: duration(state.intentAt, state.routeMountedAt),
    intent_to_prejoin_ms: duration(state.intentAt, state.prejoinReadyAt),
    join_click_to_credentials_ms: duration(state.joinRequestedAt, state.joinCredentialsReadyAt),
    join_click_to_livekit_ms: duration(state.joinRequestedAt, state.liveKitConnectedAt),
    credentials_to_livekit_ms: duration(state.joinCredentialsReadyAt, state.liveKitConnectedAt),
    join_click_to_whiteboard_ms: duration(state.joinRequestedAt, state.whiteboardReadyAt),
    livekit_to_whiteboard_ms: duration(state.liveKitConnectedAt, state.whiteboardReadyAt),
    // How long the whiteboard itself took, which is the only one of these three
    // that can answer "is WHITEBOARD_READY_TIMEOUT_MS too short". The other two
    // are anchored to the meeting join, so they also count however long someone
    // sat in the room before asking for a board — a real session logged
    // join_click_to_whiteboard_ms: 167169 for an open that took about 25s.
    whiteboard_open_ms: duration(state.whiteboardRequestedAt, state.whiteboardReadyAt),
  });
}

/**
 * Someone asked for a whiteboard.
 *
 * The only mark here that re-arms. Every other metric belongs to a one-shot
 * entry flow, so `markMeetingEntryMetric` keeps the first value it is given;
 * a whiteboard can be opened, closed and opened again in one meeting, and a
 * second open measured from the first request would be meaningless. Clearing
 * the ready mark and the logged stage lets each open be timed on its own.
 */
export function markMeetingWhiteboardRequested(options?: { code?: string }) {
  const state = getState();
  state.whiteboardRequestedAt = now();
  delete state.whiteboardReadyAt;
  state.loggedStages = (state.loggedStages ?? []).filter(
    (stage) => stage !== "whiteboard",
  );
  if (options?.code) state.code = options.code;
  writeEntryMetricsState(state);
}

export function markMeetingEntryMetric(metric: EntryMetricKey, options?: { code?: string; source?: string }) {
  const state = getState();
  if (!state[metric]) {
    state[metric] = now();
  }

  if (options?.code) state.code = options.code;
  if (options?.source) state.source = options.source;

  writeEntryMetricsState(state);

  if (metric === "liveKitConnectedAt") {
    emitStage("livekit", state);
  }

  if (metric === "whiteboardReadyAt") {
    emitStage("whiteboard", state);
  }
}

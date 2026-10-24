import { logInfo } from "@/lib/logger";
import { postTelemetry, telemetryTabId } from "@/lib/telemetry/outbox";
import type { DiagnosticDetail, DiagnosticValue } from "./diagnostic-contract";

export type MeetingEntryDiagnosticEvent =
  | "route_mounted"
  | "device_probe_completed"
  | "device_probe_failed"
  | "device_probe_timeout"
  | "join_clicked"
  | "join_rpc_timeout"
  | "admission_pending"
  | "admission_denied"
  | "reconnect_admission_discarded"
  | "access_issued"
  | "livekit_connecting"
  | "livekit_connect_timeout"
  | "livekit_connected"
  | "livekit_reconnecting"
  | "livekit_reconnected"
  | "livekit_disconnected"
  | "livekit_error"
  | "audio_playback_blocked"
  | "audio_playback_unlocked"
  | "audio_policy_resolved"
  | "active_audio_device_changed"
  | "media_device_failure"
  | "media_devices_error"
  | "initial_microphone_publish_failed"
  | "local_audio_silence_detected"
  | "local_audio_network_degraded"
  // Supersedes the per-call-site local_mic_{toggle_failed,forced_off,
  // recovery_failed} events: reconciliation reports one failure with the step
  // that failed, and the fallback to muted is implied rather than reported.
  | "local_mic_failure"
  | "local_mic_recovery_result"
  | "local_mic_unmute_recovery"
  // The system stopped a microphone the user has on (an iPadOS call takes the
  // audio session), recovery's failed restarts, and its return.
  | "local_mic_interrupted"
  | "local_mic_resume_failed"
  | "local_mic_resumed"
  // A first microphone the browser refused (a hidden page), asked for again.
  | "initial_microphone_retry"
  | "remote_track_subscription_failed"
  // The page leaving and returning to view while connected: a phone locking,
  // or the browser sent to the background, which can suspend the page.
  | "page_hidden"
  | "page_visible"
  // Another app's built-in browser, turned away before the app started. Sent
  // by the head script (app/shell/in-app-browser.ts), not by this emitter.
  | "in_app_browser_blocked";

const ENDPOINT = "/api/diagnostics/client-event";
const REDACTED_PAYLOAD_KEYS = new Set(["code", "token", "serverUrl"]);

/** The meeting and connection this tab is in, once the server has issued them. */
let scope: { meetingId: string; connectionId: string } | null = null;

export function setMeetingDiagnosticScope(next: { meetingId: string; connectionId: string } | null): void {
  scope = next;
}

function getNavigatorSnapshot(): Record<string, unknown> {
  if (typeof navigator === "undefined") return {};
  const connection = (navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number };
  }).connection;

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    effectiveType: connection?.effectiveType,
    downlink: connection?.downlink,
    rtt: connection?.rtt,
  };
}

/**
 * Emit one meeting-entry diagnostic.
 *
 * `payload` is typed against the shared wire contract rather than
 * `Record<string, unknown>`: the endpoint carries scalars and short string
 * lists, so an object would otherwise compile happily and then vanish at
 * ingest.
 */
export function emitMeetingEntryDiagnostic(
  event: MeetingEntryDiagnosticEvent,
  payload: DiagnosticDetail = {},
): void {
  if (typeof window === "undefined") return;
  const body = {
    event,
    ts: new Date().toISOString(),
    tabId: telemetryTabId(),
    ...scope,
    ...sanitizeDiagnosticPayload(payload),
    browser: getNavigatorSnapshot(),
  };

  logInfo("[MeetingEntry]", body);
  postTelemetry(ENDPOINT, body);
}

function sanitizeDiagnosticPayload(payload: DiagnosticDetail): Record<string, DiagnosticValue> {
  const sanitized: Record<string, DiagnosticValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (REDACTED_PAYLOAD_KEYS.has(key)) {
      sanitized[`${key}Present`] = typeof value === "string" && value.length > 0;
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

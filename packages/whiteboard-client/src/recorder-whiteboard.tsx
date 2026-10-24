import { useCallback, useEffect, useRef, useState } from "react";
import { SyncedWhiteboard } from "./synced-whiteboard";
import { WB_ASSET_URLS } from "./assets/engine-asset-urls";
import { useCommittedRef } from "@orbmeet/ui/react";
import { base64urlDecode } from "@orbmeet/whiteboard-core/crypto-utils";
import { buildWhiteboardConnectUrl } from "./sync/service-endpoints";
import type { WhiteboardServiceEndpoints } from "./sync/service-endpoints";
import type { WhiteboardConnectAttempt } from "./sync/whiteboard-socket-adapter";
import type { WhiteboardClientCapabilities } from "./editor/client-capabilities";
import { isAbortError } from "./editor/abort-signals";

const RECORDER_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const RECORDER_TOKEN_MIN_REFRESH_DELAY_MS = 30 * 1000;
const RECORDER_TOKEN_RETRY_INITIAL_MS = 2 * 1000;
const RECORDER_TOKEN_RETRY_MAX_MS = 30 * 1000;

export interface RecorderWhiteboardProps {
  capabilities: WhiteboardClientCapabilities;
  licenseKey?: string;
  whiteboardUrl: string;
  recorderToken: string;
  /**
   * The board the meeting presents, from its room state. The recorder follows
   * a switch by asking for access to the board the meeting presents now.
   */
  whiteboardId: string | null;
  /** Host-supplied application endpoints (recorder auth exchange). */
  serviceEndpoints: WhiteboardServiceEndpoints;
  onStatusChange?: (status: "loading" | "ready" | "error") => void;
  onContentStateChange?: (hasContent: boolean) => void;
}

interface RecorderWhiteboardAuth {
  recorderToken: string;
  token: string;
  whiteboardUrl: string;
  /** The board this access is for. */
  documentId: string | null;
  expiresAt: number | null;
}

/** Follow attempts per presented board, so a disagreement cannot loop. */
const MAX_FOLLOW_ATTEMPTS = 3;

function getTokenExpiresAt(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(new TextDecoder().decode(base64urlDecode(payload))) as {
      exp?: unknown;
    };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function requestRecorderWhiteboardAuth(
  recorderToken: string,
  recorderAuthUrl: string,
  signal: AbortSignal,
): Promise<RecorderWhiteboardAuth> {
  const response = await fetch(recorderAuthUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recorderToken }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Recorder whiteboard auth failed (${response.status})`);
  }
  const payload = await response.json() as {
    token?: unknown;
    whiteboardUrl?: unknown;
    documentId?: unknown;
  };
  if (typeof payload.token !== "string" || typeof payload.whiteboardUrl !== "string") {
    throw new Error("Recorder whiteboard auth returned an invalid payload");
  }
  return {
    recorderToken,
    token: payload.token,
    whiteboardUrl: payload.whiteboardUrl,
    documentId: typeof payload.documentId === "string" ? payload.documentId : null,
    expiresAt: getTokenExpiresAt(payload.token),
  };
}

interface RecorderAuthRequest {
  generation: number;
  recorderToken: string;
  controller: AbortController;
  promise: Promise<RecorderWhiteboardAuth>;
}

/**
 * Recorder-side whiteboard viewer.
 *
 * Connects to the whiteboard sync server via WebSocket, exactly like a regular
 * read-only meeting participant, and follows the presenter as one does: the
 * room's navigation arrives with the document it names, so the recording
 * turns pages with the presenter.
 *
 * We deliberately avoid HTTP snapshot polling. Polling bypasses the live event
 * stream, so the recorder never receives page-change signals and the camera
 * doesn't track the host's navigation. WebSocket sync already delivers the
 * full document state on connect, making the HTTP poll entirely redundant.
 */
export function RecorderWhiteboard({
  capabilities,
  licenseKey,
  whiteboardUrl,
  recorderToken,
  whiteboardId,
  serviceEndpoints,
  onStatusChange,
  onContentStateChange,
}: RecorderWhiteboardProps) {
  const [auth, setAuth] = useState<RecorderWhiteboardAuth | null>(null);
  const authRef = useRef<RecorderWhiteboardAuth | null>(null);
  const generationRef = useRef(0);
  const refreshInFlightRef = useRef<RecorderAuthRequest | null>(null);
  // Late-bound like the status callbacks in synced-whiteboard.tsx, and for a
  // sharper reason: the auth effect below aborts the in-flight request and
  // clears `auth`, and this component renders nothing without `auth`. Keying it
  // on an unmemoized `onStatusChange` — which is what a host passing an inline
  // arrow gives us — unmounted and remounted the whole canvas on every
  // unrelated host re-render, so a recording reconnected its socket and refit
  // its camera continuously. The refresh timer keyed on the same prop was
  // rescheduled from zero just as often and could never reach its ~60min
  // deadline, so the recorder token silently aged out mid-recording.
  const onStatusChangeRef = useCommittedRef(onStatusChange);

  const refreshAuth = useCallback(async () => {
    const generation = generationRef.current;
    const inFlight = refreshInFlightRef.current;
    if (
      inFlight &&
      inFlight.generation === generation &&
      inFlight.recorderToken === recorderToken
    ) {
      return inFlight.promise;
    }

    const controller = new AbortController();
    let request: RecorderAuthRequest;
    const promise = requestRecorderWhiteboardAuth(
      recorderToken,
      serviceEndpoints.recorderAuth,
      controller.signal,
    )
      .then((next) => {
        if (controller.signal.aborted || generationRef.current !== generation) {
          throw new DOMException("Recorder auth request is stale", "AbortError");
        }
        authRef.current = next;
        setAuth(next);
        return next;
      })
      .finally(() => {
        if (refreshInFlightRef.current === request) {
          refreshInFlightRef.current = null;
        }
      });
    request = { generation, recorderToken, controller, promise };
    refreshInFlightRef.current = request;
    return promise;
  }, [recorderToken, serviceEndpoints]);

  /**
   * The access to connect with: the one held while it is not near expiry,
   * else a new one. A token the sync server rejected (its claims went stale:
   * the board moved node, or its grants changed) is never sent again, however
   * long it has left — resending it only earns the same rejection.
   */
  const getFreshAuth = useCallback(async (attempt?: WhiteboardConnectAttempt) => {
    const current = authRef.current;
    if (
      !attempt?.tokenRejected &&
      current &&
      current.recorderToken === recorderToken &&
      current.expiresAt &&
      Date.now() < current.expiresAt - RECORDER_TOKEN_REFRESH_BUFFER_MS
    ) {
      return current;
    }
    return refreshAuth();
  }, [recorderToken, refreshAuth]);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    authRef.current = null;
    setAuth(null);
    onStatusChangeRef.current?.("loading");

    void refreshAuth().catch((error: unknown) => {
      if (generationRef.current !== generation || isAbortError(error)) return;
      onStatusChangeRef.current?.("error");
    });

    return () => {
      if (generationRef.current === generation) {
        generationRef.current += 1;
      }
      const inFlight = refreshInFlightRef.current;
      if (inFlight?.generation === generation) {
        inFlight.controller.abort();
        refreshInFlightRef.current = null;
      }
    };
  }, [onStatusChangeRef, recorderToken, refreshAuth]);

  useEffect(() => {
    if (!auth?.expiresAt || auth.recorderToken !== recorderToken) return;
    let stopped = false;
    let retryDelayMs = RECORDER_TOKEN_RETRY_INITIAL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delayMs: number) => {
      timer = setTimeout(() => void attemptRefresh(), delayMs);
    };
    const attemptRefresh = async () => {
      try {
        await refreshAuth();
      } catch (error) {
        if (stopped || isAbortError(error)) return;
        const current = authRef.current;
        const remainingMs = current?.expiresAt
          ? current.expiresAt - Date.now()
          : 0;
        if (remainingMs <= 0) {
          onStatusChangeRef.current?.("error");
          return;
        }
        // A proactive refresh failure does not invalidate the connected JWT.
        // Keep the live recorder mounted and retry within the token's remaining
        // lifetime. Only expiry makes the failure terminal.
        schedule(Math.min(retryDelayMs, remainingMs));
        retryDelayMs = Math.min(
          retryDelayMs * 2,
          RECORDER_TOKEN_RETRY_MAX_MS,
        );
      }
    };

    schedule(Math.max(
      auth.expiresAt - Date.now() - RECORDER_TOKEN_REFRESH_BUFFER_MS,
      RECORDER_TOKEN_MIN_REFRESH_DELAY_MS,
    ));
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [auth?.expiresAt, auth?.recorderToken, onStatusChangeRef, recorderToken, refreshAuth]);

  // The meeting switched boards: ask for access to the one it presents now.
  const followAttemptsRef = useRef<{ whiteboardId: string | null; attempts: number }>({
    whiteboardId: null,
    attempts: 0,
  });
  useEffect(() => {
    if (!auth || !whiteboardId || auth.documentId === whiteboardId) return;
    const follow = followAttemptsRef.current;
    if (follow.whiteboardId !== whiteboardId) {
      followAttemptsRef.current = { whiteboardId, attempts: 0 };
    }
    if (followAttemptsRef.current.attempts >= MAX_FOLLOW_ATTEMPTS) return;
    followAttemptsRef.current.attempts += 1;
    void refreshAuth().catch((error: unknown) => {
      if (isAbortError(error)) return;
      console.warn("[Recorder] Could not follow the presented whiteboard:", error);
    });
  }, [auth, refreshAuth, whiteboardId]);

  const getWebSocketUri = useCallback(async (attempt: WhiteboardConnectAttempt) => {
    const next = await getFreshAuth(attempt);
    const url = buildWhiteboardConnectUrl(
      next.whiteboardUrl || whiteboardUrl,
      next.token,
    );
    return url;
  }, [getFreshAuth, whiteboardUrl]);

  if (!auth || auth.recorderToken !== recorderToken) return null;

  return (
    <SyncedWhiteboard
      key={auth.documentId ?? "whiteboard"}
      capabilities={capabilities}
      licenseKey={licenseKey}
      whiteboardUrl={auth.whiteboardUrl || whiteboardUrl}
      token={auth.token}
      getWebSocketUri={getWebSocketUri}
      assetUrls={WB_ASSET_URLS}
      onStatusChange={(status) => {
        onStatusChange?.(status === "fatal" ? "error" : status);
      }}
      onContentStateChange={onContentStateChange}
      aiEnabled={false}
      // The recording shows what the room is shown: it follows the presenter.
      presents
      readOnlySurface
    />
  );
}

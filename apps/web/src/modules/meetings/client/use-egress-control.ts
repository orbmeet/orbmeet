import * as React from "react";
import type { Room } from "livekit-client";
import type { useToast } from "@orbmeet/ui/react";
import { useCommittedRef } from "@orbmeet/ui/react";
import { logError } from "@/lib/logger";
import type { MeetingRoomState } from "@/modules/meetings/contract/live-state";
import type { StreamingPlatform } from "@/modules/meetings/contract/schemas";
import { setRecording, setStreaming } from "@/modules/meetings/server/runtime/live.functions";
import { useMeetingRoomState } from "./use-meeting-live-state";

type Mode = "recording" | "streaming";

export interface EgressCopy {
  started: { title: string; description: string };
  stopped: { title: string; description: string };
  failedToStart: string;
  failedToStop: string;
  interrupted: { title: string; description: string };
}

type EgressToggleResult = {
  status: "starting" | "active" | "stopping" | null;
  lastFailure: string | null;
  revision: number;
};

/**
 * Recording or streaming, as the meeting's coordinator runs it. A toggle is
 * accepted at once and the egress starts in the background; room metadata
 * reports when it is live, when it stops, and when it fails.
 *
 * What the control shows is derived from the room's current state, never from
 * remembered events. A request is pending until the room's egress revision
 * moves past the one the request was accepted at: the revision only moves when
 * an egress starts, stops or fails, so whichever of the reply and the room
 * update arrives first, the other cannot reinstate a settled request.
 */
export function useEgressControl<TStart = undefined>({
  mode,
  initiallyActive,
  initialRevision,
  roomInstance,
  roomState: providedRoomState,
  addToast,
  copy,
  toggle,
}: {
  mode: Mode;
  initiallyActive: boolean;
  initialRevision: number;
  roomInstance: Room | undefined;
  roomState?: MeetingRoomState | null;
  addToast: ReturnType<typeof useToast>["add"];
  copy: EgressCopy;
  toggle: (on: boolean, payload?: TStart) => Promise<EgressToggleResult>;
}) {
  const roomState = useMeetingRoomState(roomInstance, providedRoomState);
  const known = roomState && roomState.egressRevision >= initialRevision ? roomState : null;
  const revision = known?.egressRevision ?? initialRevision;
  const active = known ? known.egressMode === mode : initiallyActive;
  /** The request, and the revision it was accepted at. */
  const [requested, setRequested] = React.useState<{ kind: "start" | "stop"; revision: number } | null>(null);
  const [inFlight, setInFlight] = React.useState(false);
  const inFlightRef = React.useRef(false);
  const copyRef = useCommittedRef(copy);
  const addToastRef = useCommittedRef(addToast);
  const revisionRef = useCommittedRef(revision);
  const settled = requested !== null && revision > requested.revision;
  const outstanding = settled ? null : requested;

  // Tell the user what a change of the room's state meant for them. `wasActive`
  // is what the room reported before this change, so an egress that ends on its
  // own is reported as interrupted even though it is no longer active now.
  const seenRef = React.useRef({ revision: initialRevision, active: initiallyActive });
  React.useEffect(() => {
    const seen = seenRef.current;
    if (!known || known.egressRevision <= seen.revision) return;
    seenRef.current = { revision: known.egressRevision, active };
    const text = copyRef.current;
    if (known.egressTransition === "started" && known.egressMode === mode) {
      if (requested?.kind === "start") addToastRef.current({ ...text.started, data: { variant: "success" } });
    } else if (known.egressTransition === "failed") {
      if (requested?.kind === "start" || seen.active) {
        addToastRef.current({ ...text.interrupted, data: { variant: "error" } });
      }
    } else if (known.egressTransition === "stopped") {
      if (requested?.kind === "stop") addToastRef.current({ ...text.stopped, data: { variant: "info" } });
    }
  }, [active, addToastRef, copyRef, known, mode, requested]);

  // A settled request is dropped, so the next one starts clean.
  React.useEffect(() => {
    if (settled) setRequested(null);
  }, [settled]);

  const run = React.useCallback(async (on: boolean, payload?: TStart) => {
    if (inFlightRef.current) throw new Error("A request is already in progress.");
    inFlightRef.current = true;
    setInFlight(true);
    // Registered before sending, so a room update that beats the reply still
    // finds the request it answers.
    const kind = on ? "start" : "stop";
    setRequested({ kind, revision: revisionRef.current });
    try {
      const result = await toggle(on, payload);
      const alreadyThere = on ? result.status === "active" : result.status === null;
      setRequested(alreadyThere ? null : { kind, revision: result.revision });
      if (!on && result.status === null) {
        addToastRef.current({ ...copyRef.current.stopped, data: { variant: "info" } });
      }
    } catch (error) {
      setRequested(null);
      logError(`[Meeting] ${mode} toggle failed:`, error);
      addToastRef.current({
        title: on ? copyRef.current.failedToStart : copyRef.current.failedToStop,
        description: error instanceof Error && error.message ? error.message : "Something went wrong",
        data: { variant: "error" },
      });
      throw error;
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, [addToastRef, copyRef, mode, revisionRef, toggle]);

  return { active, pending: inFlight || outstanding !== null, run };
}

const RECORDING_COPY: EgressCopy = {
  started: { title: "Recording in progress", description: "This meeting is being recorded." },
  stopped: {
    title: "Recording stopped",
    description: "The recording is being processed and will appear in assets when it is ready.",
  },
  failedToStart: "Recording failed",
  failedToStop: "Could not stop recording",
  interrupted: {
    title: "Recording stopped unexpectedly",
    description: "The recording was interrupted before it could be saved.",
  },
};

export function useMeetingRecording({
  meetingId,
  recordingActive,
  egressStateRevision,
  roomInstance,
  roomState,
  addToast,
}: {
  meetingId: string;
  recordingActive: boolean;
  egressStateRevision: number;
  roomInstance: Room | undefined;
  roomState?: MeetingRoomState | null;
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const control = useEgressControl({
    mode: "recording",
    initiallyActive: recordingActive,
    initialRevision: egressStateRevision,
    roomInstance,
    roomState,
    addToast,
    copy: RECORDING_COPY,
    toggle: React.useCallback((on: boolean) => setRecording({ data: { meetingId, on } }), [meetingId]),
  });
  const { active, run } = control;
  const handleToggleRecording = React.useCallback(async () => {
    await run(!active).catch(() => undefined);
  }, [active, run]);

  return {
    isRecording: control.active,
    recordingPending: control.pending,
    handleToggleRecording,
  };
}

const STREAMING_COPY: EgressCopy = {
  started: { title: "Streaming live", description: "Your meeting is now live." },
  stopped: { title: "Stream ended", description: "Stream has ended." },
  failedToStart: "Stream failed to start",
  failedToStop: "Could not stop stream",
  interrupted: {
    title: "Stream disconnected",
    description: "Your live stream ended unexpectedly. Check your stream key and try again.",
  },
};

export function useMeetingStreaming({
  meetingId,
  streamingActive,
  egressStateRevision,
  roomInstance,
  roomState,
  addToast,
}: {
  meetingId: string;
  streamingActive: boolean;
  egressStateRevision: number;
  roomInstance: Room | undefined;
  roomState?: MeetingRoomState | null;
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const control = useEgressControl<{ platform: StreamingPlatform; streamKey: string }>({
    mode: "streaming",
    initiallyActive: streamingActive,
    initialRevision: egressStateRevision,
    roomInstance,
    roomState,
    addToast,
    copy: STREAMING_COPY,
    toggle: React.useCallback(
      (on, target) => setStreaming({ data: { meetingId, on, ...(on ? target : {}) } }),
      [meetingId],
    ),
  });
  const { run } = control;

  const handleStartStreaming = React.useCallback(
    (platform: StreamingPlatform, streamKey: string) => run(true, { platform, streamKey }),
    [run],
  );
  const handleStopStreaming = React.useCallback(() => run(false), [run]);

  return {
    isStreaming: control.active,
    streamingPending: control.pending,
    handleStartStreaming,
    handleStopStreaming,
  };
}

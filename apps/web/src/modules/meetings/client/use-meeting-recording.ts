import * as React from "react";
import type { Room } from "livekit-client";
import type { useToast } from "@orbmeet/ui/react";
import { setRecording } from "@/modules/meetings/server/runtime/live.functions";
import { useEgressControl, type EgressCopy } from "./use-egress-control";

const COPY: EgressCopy = {
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
  addToast,
}: {
  meetingId: string;
  recordingActive: boolean;
  egressStateRevision: number;
  roomInstance: Room | undefined;
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const control = useEgressControl({
    mode: "recording",
    initiallyActive: recordingActive,
    initialRevision: egressStateRevision,
    roomInstance,
    addToast,
    copy: COPY,
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

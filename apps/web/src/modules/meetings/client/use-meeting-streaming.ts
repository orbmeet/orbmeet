import * as React from "react";
import type { Room } from "livekit-client";
import type { useToast } from "@orbmeet/ui/react";
import type { StreamingPlatform } from "@/modules/meetings/contract/schemas";
import { setStreaming } from "@/modules/meetings/server/runtime/live.functions";
import { useEgressControl, type EgressCopy } from "./use-egress-control";

const COPY: EgressCopy = {
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
  addToast,
}: {
  meetingId: string;
  streamingActive: boolean;
  egressStateRevision: number;
  roomInstance: Room | undefined;
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const platformRef = React.useRef<{ platform: StreamingPlatform; streamKey: string } | null>(null);
  const control = useEgressControl({
    mode: "streaming",
    initiallyActive: streamingActive,
    initialRevision: egressStateRevision,
    roomInstance,
    addToast,
    copy: COPY,
    toggle: React.useCallback(
      (on: boolean) => setStreaming({ data: { meetingId, on, ...(on ? platformRef.current : {}) } }),
      [meetingId],
    ),
  });
  const { run } = control;

  const handleStartStreaming = React.useCallback(async (platform: StreamingPlatform, streamKey: string) => {
    platformRef.current = { platform, streamKey };
    try {
      await run(true);
    } finally {
      platformRef.current = null;
    }
  }, [run]);
  const handleStopStreaming = React.useCallback(() => run(false), [run]);

  return {
    isStreaming: control.active,
    streamingPending: control.pending,
    handleStartStreaming,
    handleStopStreaming,
  };
}

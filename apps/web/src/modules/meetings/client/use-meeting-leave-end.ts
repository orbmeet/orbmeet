import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { logError } from "@/lib/logger";
import { endMeeting, leaveMeeting } from "@/modules/meetings/server/runtime/live.functions";
import { clearReconnectAdmissionId } from "./reconnect-storage";
import { queryKeys } from "@/app/query-client/query-keys";
import type { MeetingLifecycleHooks } from "./types";
import type { useToast } from "@orbmeet/ui/react";
import { meetingHistoryPath } from "@/modules/meetings/client/urls";

export function useMeetingLeaveEnd({
  meetingId,
  connectionId,
  admissionId,
  code,
  isAuthenticated,
  navigate,
  queryClient,
  onIntentionalDisconnect,
  lifecycleHooks,
  disconnectMeetingNow,
  addToast,
}: {
  meetingId: string;
  connectionId: string;
  admissionId: string;
  code: string;
  isAuthenticated: boolean;
  navigate: ReturnType<typeof useNavigate>;
  queryClient: ReturnType<typeof useQueryClient>;
  onIntentionalDisconnect: () => void;
  lifecycleHooks?: MeetingLifecycleHooks;
  disconnectMeetingNow: () => Promise<void>;
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const actionPendingRef = React.useRef(false);
  const [actionPending, setActionPending] = React.useState(false);
  const handleLeave = React.useCallback(async () => {
    if (actionPendingRef.current) return;
    actionPendingRef.current = true;
    setActionPending(true);
    onIntentionalDisconnect();
    try {
      await lifecycleHooks?.onBeforeLeave?.();
    } catch (err) {
      logError("[Meeting] Failed to run onBeforeLeave hook:", err);
      addToast({
        title: "Pre-leave action failed",
        description: "You will leave, but some data may not have been saved.",
        data: { variant: "error" },
      });
    }
    await disconnectMeetingNow();
    try {
      await leaveMeeting({
        data: { meetingId, connectionId },
      });
    } catch (err) {
      logError("[Meeting] Failed to leave:", err);
    }
    clearReconnectAdmissionId(code);
    if (isAuthenticated) {
      void navigate({ to: "/home" });
    } else {
      void navigate({
        to: "/handoff/$meetingId",
        params: { meetingId },
        search: { admissionId },
      });
    }
  }, [
    meetingId,
    connectionId,
    isAuthenticated,
    navigate,
    onIntentionalDisconnect,
    lifecycleHooks,
    disconnectMeetingNow,
    code,
    admissionId,
    addToast,
  ]);

  const [showEndConfirm, setShowEndConfirm] = React.useState(false);

  const handleEnd = React.useCallback(async () => {
    setShowEndConfirm(true);
  }, []);

  const confirmLeave = React.useCallback(async () => {
    setShowEndConfirm(false);
    await handleLeave();
  }, [handleLeave]);

  const confirmEnd = React.useCallback(async () => {
    if (actionPendingRef.current) return;
    actionPendingRef.current = true;
    setActionPending(true);
    setShowEndConfirm(false);
    try {
      await lifecycleHooks?.onBeforeEnd?.();
    } catch (err) {
      logError("[Meeting] Failed to run onBeforeEnd hook:", err);
      addToast({
        title: "Pre-end action failed",
        description: "The meeting will end, but some data may not have been saved.",
        data: { variant: "error" },
      });
    }
    try {
      await endMeeting({ data: { meetingId: meetingId } });
    } catch (err) {
      logError("[Meeting] Failed to end:", err);
      addToast({
        title: "Could not end meeting",
        description: "Please try again.",
        data: { variant: "error" },
      });
      actionPendingRef.current = false;
      setActionPending(false);
      return;
    }
    // Mark intentional only after the server confirms the room is being torn
    // down — so that if endMeeting() throws, external disconnects (webhook,
    // another host) still trigger the normal handling path in the parent.
    onIntentionalDisconnect();
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: queryKeys.meetings.lists() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.threads() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.meetings.summaries() }),
    ]);
    await disconnectMeetingNow();
    clearReconnectAdmissionId(code);
    window.location.assign(meetingHistoryPath(meetingId));
  }, [
    addToast,
    meetingId,
    onIntentionalDisconnect,
    lifecycleHooks,
    disconnectMeetingNow,
    code,
    queryClient,
  ]);

  return {
    showEndConfirm,
    actionPending,
    setShowEndConfirm,
    handleLeave,
    handleEnd,
    confirmLeave,
    confirmEnd,
  };
}

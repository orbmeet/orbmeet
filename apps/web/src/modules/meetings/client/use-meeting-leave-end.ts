import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { logError } from "@/lib/logger";
import { endMeeting, leaveMeeting } from "@/modules/meetings/server/runtime/live.functions";
import { clearReconnectAdmissionId } from "./reconnect-storage";
import type { MeetingLifecycleHooks } from "./types";
import type { useToast } from "@orbmeet/ui/react";
import { meetingHistoryPath } from "@/modules/meetings/client/urls";

/** How long leaving waits to tell the server, before going anyway. */
const LEAVE_NOTICE_WAIT_MS = 3_000;

export function useMeetingLeaveEnd({
  meetingId,
  connectionId,
  admissionId,
  code,
  isAuthenticated,
  navigate,
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
    // Telling the server ends the connection at once; without it, the server
    // ends it once it has been gone a while. A courtesy, then, which must not
    // hold anyone on the way out of a connection that is failing.
    await Promise.race([
      leaveMeeting({ data: { meetingId, connectionId } }).catch((err: unknown) => {
        logError("[Meeting] Failed to leave:", err);
      }),
      new Promise((resolve) => setTimeout(resolve, LEAVE_NOTICE_WAIT_MS)),
    ]);
    clearReconnectAdmissionId(code);
    // Out of the meeting's document: Home loads afresh, lists and all.
    if (isAuthenticated) {
      void navigate({ to: "/home", search: { left: meetingId } });
    } else {
      void navigate({
        to: "/handoff/$meetingId",
        params: { meetingId },
        search: { admissionId, code },
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

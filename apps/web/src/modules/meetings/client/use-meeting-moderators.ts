import * as React from "react";
import type { useToast } from "@orbmeet/ui/react";
import { getErrorMessage } from "@/lib/error-inspection";
import { logError } from "@/lib/logger";
import { setMeetingModerator } from "@/modules/meetings/server/runtime/live.functions";

export function useMeetingModerators({
  meetingId,
  canManageMeeting,
  addToast,
}: {
  meetingId: string;
  canManageMeeting: boolean;
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const [pendingIdentities, setPendingIdentities] = React.useState<Set<string>>(
    () => new Set(),
  );

  const setModerator = React.useCallback(
    async (participantIdentity: string, moderator: boolean) => {
      if (!canManageMeeting || pendingIdentities.has(participantIdentity)) return;
      setPendingIdentities((current) => new Set(current).add(participantIdentity));
      try {
        await setMeetingModerator({
          data: {
            meetingId,
            targetParticipantIdentity: participantIdentity,
            moderator,
          },
        });
        addToast({
          title: moderator ? "Moderator added" : "Moderator removed",
          description: moderator
            ? "They can now manage the meeting and whiteboard."
            : "Their meeting moderator access has been removed.",
          data: { variant: "success" },
        });
      } catch (error) {
        logError("[Meeting] Failed to update moderator:", error);
        addToast({
          title: "Moderator update failed",
          description: getErrorMessage(error, "Could not update this participant."),
          data: { variant: "error" },
        });
      } finally {
        setPendingIdentities((current) => {
          const next = new Set(current);
          next.delete(participantIdentity);
          return next;
        });
      }
    },
    [addToast, canManageMeeting, meetingId, pendingIdentities],
  );

  return { pendingIdentities, setModerator };
}

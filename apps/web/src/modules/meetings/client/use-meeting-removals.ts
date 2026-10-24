import * as React from "react";
import type { Room } from "livekit-client";
import type { useToast } from "@orbmeet/ui/react";
import { getErrorMessage } from "@/lib/error-inspection";
import { logError } from "@/lib/logger";
import { PARTICIPANT_ATTRIBUTE } from "@/modules/meetings/contract/live-state";
import { removeParticipant as removeParticipantRpc } from "@/modules/meetings/server/runtime/live.functions";

type KeptOut = Awaited<ReturnType<typeof removeParticipantRpc>>["keptOut"];

/** What the room actually keeps out after a removal, in the moderator's words. */
function removalDescription(name: string, keptOut: KeptOut): string {
  switch (keptOut) {
    case "account":
      return `${name} can't rejoin this meeting.`;
    case "network":
      return `${name} can't rejoin as a guest from the same network.`;
    case "none":
      return `${name} could rejoin as a new guest.`;
  }
}

/**
 * A moderator taking a participant out of the meeting. The room removes them
 * from LiveKit and keeps out what it can identify (see `removalDescription`);
 * their tile leaves when LiveKit reports them gone.
 */
export function useMeetingRemovals({
  meetingId,
  connectionId,
  canModerate,
  room,
  addToast,
}: {
  meetingId: string;
  connectionId: string;
  canModerate: boolean;
  room: Room | undefined;
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const [pendingIdentities, setPendingIdentities] = React.useState<ReadonlySet<string>>(() => new Set());

  const removeParticipant = React.useCallback(
    async (identity: string) => {
      if (!canModerate || pendingIdentities.has(identity)) return;
      const participant = room?.remoteParticipants.get(identity);
      const admissionId = participant?.attributes[PARTICIPANT_ATTRIBUTE.participant];
      if (!admissionId) return;
      setPendingIdentities((current) => new Set(current).add(identity));
      try {
        const { keptOut } = await removeParticipantRpc({ data: { meetingId, connectionId, admissionId } });
        addToast({
          title: "Participant removed",
          description: removalDescription(participant.name || "They", keptOut),
          data: { variant: "success" },
        });
      } catch (error) {
        logError("[Meeting] Failed to remove participant:", error);
        addToast({
          title: "Couldn't remove participant",
          description: getErrorMessage(error, "Could not remove this participant."),
          data: { variant: "error" },
        });
      } finally {
        setPendingIdentities((current) => {
          const next = new Set(current);
          next.delete(identity);
          return next;
        });
      }
    },
    [addToast, canModerate, connectionId, meetingId, pendingIdentities, room],
  );

  return { pendingIdentities, removeParticipant };
}

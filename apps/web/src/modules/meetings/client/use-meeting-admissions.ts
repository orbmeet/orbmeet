import * as React from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Room } from "livekit-client";
import { getErrorMessage } from "@/lib/error-inspection";
import { logError } from "@/lib/logger";
import type { useToast } from "@orbmeet/ui/react";
import { queryKeys } from "@/app/query-client/query-keys";
import { decideAdmission, listPendingAdmissions } from "@/modules/meetings/server/runtime/live.functions";
import { useMeetingRoomState } from "./use-meeting-live-state";
import type { HostPermissionRequest } from "./types";

/** After a failed fetch of the waiting list, the next try. */
const ADMISSION_FETCH_RETRY_MS = 5_000;

type PendingAdmissions = Awaited<ReturnType<typeof listPendingAdmissions>>;

/**
 * Who is waiting to be let in, for a moderator.
 *
 * The coordinator bumps `admissionsVersion` in room metadata whenever someone
 * starts or stops waiting, and LiveKit shows every participant the room's
 * current metadata on (re)connect. The list is read per version: each answer
 * is kept under the version it answers, so one that arrives late can never
 * stand in for a newer one.
 */
export function useMeetingAdmissions({
  meetingId,
  managerConnectionId,
  canModerate,
  room,
  addToast,
}: {
  meetingId: string;
  managerConnectionId: string;
  canModerate: boolean;
  room: Room | undefined;
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const queryClient = useQueryClient();
  const admissionsVersion = useMeetingRoomState(room)?.admissionsVersion;
  const queryKey = React.useMemo(
    () => queryKeys.meetings.pendingAdmissions(meetingId, managerConnectionId, admissionsVersion),
    [admissionsVersion, managerConnectionId, meetingId],
  );
  const { data, refetch } = useQuery({
    queryKey,
    queryFn: () => listPendingAdmissions({ data: { meetingId, connectionId: managerConnectionId } }),
    enabled: canModerate,
    // Between versions, the last list stays up rather than blinking empty.
    placeholderData: keepPreviousData,
    retry: true,
    retryDelay: ADMISSION_FETCH_RETRY_MS,
  });
  const [pendingDecisionIds, setPendingDecisionIds] = React.useState<ReadonlySet<string>>(() => new Set());

  const decide = React.useCallback(
    async (admissionId: string, approve: boolean) => {
      if (pendingDecisionIds.has(admissionId)) return;
      setPendingDecisionIds((current) => new Set(current).add(admissionId));
      try {
        await decideAdmission({ data: { meetingId, admissionId, approve, connectionId: managerConnectionId } });
        // Gone from the list now; the version bump that follows confirms it.
        queryClient.setQueryData<PendingAdmissions>(queryKey, (current) =>
          current && { ...current, pending: current.pending.filter((request) => request.id !== admissionId) },
        );
      } catch (err) {
        logError(`[Meeting] Failed to ${approve ? "admit" : "deny"} participant:`, err);
        addToast({
          title: approve ? "Admission failed" : "Denial failed",
          description: getErrorMessage(err, approve ? "Could not admit this participant." : "Could not deny this participant."),
          data: { variant: "error" },
        });
        void refetch();
      } finally {
        setPendingDecisionIds((current) => {
          const next = new Set(current);
          next.delete(admissionId);
          return next;
        });
      }
    },
    [addToast, managerConnectionId, meetingId, pendingDecisionIds, queryClient, queryKey, refetch],
  );

  const hostPermissionRequests = React.useMemo<HostPermissionRequest[]>(
    () =>
      canModerate
        ? (data?.pending ?? []).map((request) => ({
            kind: "meeting-admission" as const,
            id: `admission-${request.id}`,
            admissionId: request.id,
            userId: request.userId,
            userName: request.displayName,
            role: request.role,
            decisionPending: pendingDecisionIds.has(request.id),
          }))
        : [],
    [canModerate, data, pendingDecisionIds],
  );

  return {
    hostPermissionRequests,
    handleApproveAdmission: React.useCallback((admissionId: string) => decide(admissionId, true), [decide]),
    handleDenyAdmission: React.useCallback((admissionId: string) => decide(admissionId, false), [decide]),
  };
}

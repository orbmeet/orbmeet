import * as React from "react";
import type { Room } from "livekit-client";
import { getErrorMessage } from "@/lib/error-inspection";
import { logError } from "@/lib/logger";
import type { useToast } from "@orbmeet/ui/react";
import { decideAdmission, listPendingAdmissions } from "@/modules/meetings/server/runtime/live.functions";
import { useMeetingRoomState } from "./use-meeting-live-state";
import type { HostPermissionRequest } from "./types";

/** After a failed fetch of the waiting list, the next try. */
const ADMISSION_FETCH_RETRY_MS = 5_000;

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
  const [hostPermissionRequests, setHostPermissionRequests] = React.useState<HostPermissionRequest[]>([]);
  const [pendingDecisionIds, setPendingDecisionIds] = React.useState<Set<string>>(() => new Set());
  const pendingDecisionIdsRef = React.useRef<Set<string>>(new Set());

  const setDecisionPending = React.useCallback((admissionId: string, pending: boolean) => {
    if (pending) pendingDecisionIdsRef.current.add(admissionId);
    else pendingDecisionIdsRef.current.delete(admissionId);
    setPendingDecisionIds(new Set(pendingDecisionIdsRef.current));
  }, []);

  /** Resolves false on a failure. */
  const refreshPendingAdmissions = React.useCallback(async (): Promise<boolean> => {
    if (!canModerate) {
      setHostPermissionRequests([]);
      return true;
    }

    try {
      const result = await listPendingAdmissions({
        data: { meetingId, connectionId: managerConnectionId },
      });
      setHostPermissionRequests(
        result.pending.map((request) => ({
          kind: "meeting-admission" as const,
          id: `admission-${request.id}`,
          admissionId: request.id,
          userId: request.userId,
          userName: request.displayName,
          role: request.role,
        })),
      );
      return true;
    } catch (err) {
      logError("[Meeting] Failed to list pending admissions:", err);
      return false;
    }
  }, [canModerate, managerConnectionId, meetingId]);

  React.useEffect(() => {
    if (!canModerate) {
      setHostPermissionRequests([]);
      pendingDecisionIdsRef.current.clear();
      setPendingDecisionIds(new Set());
    }
  }, [canModerate]);

  // The coordinator bumps `admissionsVersion` in room metadata whenever
  // someone starts or stops waiting, and LiveKit shows every participant the
  // room's current metadata on (re)connect, so the list is fetched when it
  // changes and when this participant becomes a moderator. Only a failed
  // fetch is tried again.
  const admissionsVersion = useMeetingRoomState(room)?.admissionsVersion;
  React.useEffect(() => {
    if (!canModerate) return;
    let cancelled = false;
    let retry: number | undefined;
    const load = async () => {
      if (!(await refreshPendingAdmissions()) && !cancelled) {
        retry = window.setTimeout(() => void load(), ADMISSION_FETCH_RETRY_MS);
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, [admissionsVersion, canModerate, refreshPendingAdmissions]);

  const removeAdmissionRequest = React.useCallback((admissionId: string) => {
    setHostPermissionRequests((requests) =>
      requests.filter((request) => request.kind !== "meeting-admission" || request.admissionId !== admissionId),
    );
  }, []);

  const handleApproveAdmission = React.useCallback(
    async (admissionId: string) => {
      if (pendingDecisionIdsRef.current.has(admissionId)) return;
      setDecisionPending(admissionId, true);
      try {
        await decideAdmission({
          data: { meetingId, admissionId, approve: true, connectionId: managerConnectionId },
        });
        removeAdmissionRequest(admissionId);
      } catch (err) {
        logError("[Meeting] Failed to admit participant:", err);
        addToast({
          title: "Admission failed",
          description: getErrorMessage(err, "Could not admit this participant."),
          data: { variant: "error" },
        });
        await refreshPendingAdmissions();
      } finally {
        setDecisionPending(admissionId, false);
      }
    },
    [addToast, managerConnectionId, meetingId, refreshPendingAdmissions, removeAdmissionRequest, setDecisionPending],
  );

  const handleDenyAdmission = React.useCallback(
    async (admissionId: string) => {
      if (pendingDecisionIdsRef.current.has(admissionId)) return;
      setDecisionPending(admissionId, true);
      try {
        await decideAdmission({
          data: { meetingId, admissionId, approve: false, connectionId: managerConnectionId },
        });
        removeAdmissionRequest(admissionId);
      } catch (err) {
        logError("[Meeting] Failed to deny participant:", err);
        addToast({
          title: "Denial failed",
          description: getErrorMessage(err, "Could not deny this participant."),
          data: { variant: "error" },
        });
        await refreshPendingAdmissions();
      } finally {
        setDecisionPending(admissionId, false);
      }
    },
    [addToast, managerConnectionId, meetingId, refreshPendingAdmissions, removeAdmissionRequest, setDecisionPending],
  );

  const visibleHostPermissionRequests = React.useMemo(
    () => hostPermissionRequests.map((request) => ({
      ...request,
      decisionPending: request.kind === "meeting-admission"
        ? pendingDecisionIds.has(request.admissionId)
        : false,
    })),
    [hostPermissionRequests, pendingDecisionIds],
  );

  return {
    hostPermissionRequests: visibleHostPermissionRequests,
    handleApproveAdmission,
    handleDenyAdmission,
  };
}

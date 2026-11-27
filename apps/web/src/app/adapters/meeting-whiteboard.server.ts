import "@tanstack/react-start/server-only";
import type { MeetingJoinSurfaceResolver } from "@/modules/meetings/server/lifecycle/join.server";
import type { MeetingWhiteboardEffects } from "@/modules/meetings/server/runtime/effects.server";
import { isWhiteboardConfigured } from "@/modules/whiteboards/server/config.server";
import { pinMeetingWhiteboardSharedState } from "@/modules/whiteboards/server/document-revisions";
import { findMeetingWhiteboardDocument } from "@/modules/whiteboards/server/documents";
import { refreshBoardAuthority } from "@/modules/whiteboards/server/meeting/authority.server";
import { resolveWhiteboardCapabilities } from "@/modules/whiteboards/server/meeting/grants";
import {
  buildWhiteboardJoinAccessExtras,
  getWhiteboardRecorderCustomBaseUrl,
  whiteboardCapabilitiesForMeetingRole,
  whiteboardRoleForMeetingIdentity,
} from "@/modules/whiteboards/server/orchestration.server";

/**
 * App-layer wiring that bridges `modules/meetings` to `modules/whiteboards`
 * without introducing a circular dependency between feature modules.
 */
export const meetingWhiteboardEffects: MeetingWhiteboardEffects = {
  getRecorderCustomBaseUrl: (env, meetingId, options) =>
    getWhiteboardRecorderCustomBaseUrl(env, meetingId, options),
  pinSharedState: async (db, env, input) => {
    if (!isWhiteboardConfigured(env)) return;
    await pinMeetingWhiteboardSharedState(db, env, input);
  },
  refreshAuthority: (env, syncRoomId, principalKey) =>
    refreshBoardAuthority(env, syncRoomId, principalKey),
};

export const resolveMeetingJoinSurface: MeetingJoinSurfaceResolver = async ({
  db,
  env,
  meetingId,
  participant,
}) => {
  const grantPrincipal = participant.userId
    ? { type: "user" as const, id: participant.userId }
    : { type: "guest_admission" as const, id: participant.admissionId };

  const [whiteboardDocument, { capabilities: participantCapabilities }] = await Promise.all([
    findMeetingWhiteboardDocument(db, meetingId),
    resolveWhiteboardCapabilities(db, {
      meetingId,
      principal: grantPrincipal,
      base: whiteboardCapabilitiesForMeetingRole(participant.role),
    }),
  ]);

  return buildWhiteboardJoinAccessExtras(env, {
    meetingId,
    mediaNodeId: participant.nodeId,
    participantIdentity: participant.identity,
    participantName: participant.displayName,
    participantRole: whiteboardRoleForMeetingIdentity(participant.role, participant.identity),
    participantCapabilities,
    grantPrincipal,
    connectionId: participant.attemptId,
    whiteboardDocument: whiteboardDocument
      ? {
          whiteboardId: whiteboardDocument.whiteboardId,
          syncRoomId: whiteboardDocument.syncRoomId,
          title: whiteboardDocument.title,
          surfaceOpen: whiteboardDocument.status === "active" && whiteboardDocument.surfaceOpen,
        }
      : undefined,
  });
};

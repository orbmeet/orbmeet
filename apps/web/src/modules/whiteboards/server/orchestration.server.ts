import "@tanstack/react-start/server-only";
import type { JoinResult } from "@/modules/meetings/contract/types";
import {
  createWhiteboardJWT,
  type WhiteboardCapabilities,
  type WhiteboardRole,
} from "@orbmeet/whiteboard-core/whiteboard-jwt";
import type { WhiteboardGrantPrincipal } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import {
  setWhiteboardAssetCookies,
  clearWhiteboardAssetCookie,
} from "@/modules/whiteboards/server/cookies";
import { buildRecorderUrl } from "@/modules/whiteboards/server/recorder-url";
import { createRecorderBootstrapToken } from "@/modules/whiteboards/server/recorder-bootstrap-token";
import { isWhiteboardConfigured, whiteboardNodes } from "@/modules/whiteboards/server/config.server";
import { mediaNodes } from "@/platform/realtime/nodes";
import { placeBoard } from "@/modules/whiteboards/server/board-placement.server";
import { createDb } from "@orbmeet/db";
import { findMeetingWhiteboardDocument } from "@/modules/whiteboards/server/documents";

export {
  whiteboardCapabilitiesForMeetingRole,
  whiteboardRoleForMeetingIdentity,
} from "@/modules/whiteboards/server/meeting/role";
import { logInfo } from "@/lib/logger";

export interface JoinAccessHookParams {
  participantIdentity: string;
  participantName: string;
  participantRole: WhiteboardRole;
  participantCapabilities: WhiteboardCapabilities;
  grantPrincipal: WhiteboardGrantPrincipal;
  meetingId: string;
  /** The node hosting the Meeting's media: a board it shows moves there. */
  mediaNodeId: string | null;
  connectionId: string;
  whiteboardDocument?: {
    whiteboardId: string;
    syncRoomId: string;
    title: string;
    surfaceOpen: boolean;
  };
}

export async function buildWhiteboardJoinAccessExtras(
  env: Env,
  params: JoinAccessHookParams,
): Promise<Partial<JoinResult>> {
  if (!isWhiteboardConfigured(env)) {
    return {
      surface: {
        availability: "unavailable",
        disabledReason: null,
        surfaceOpen: false,
        token: null,
        url: null,
      },
    };
  }

  // NOTE: deliberately no live /health probe here. This runs on every token
  // refresh, so a flaky probe (or its 30s negative cache) would demote an
  // otherwise-healthy board to "unavailable" and strip its token — leaving the
  // client nothing to reconnect with once the blip passes. A genuinely down
  // server surfaces as the adapter retrying (a loading state), and a true
  // version mismatch is still caught by the sync protocol at /connect time.
  const document = params.whiteboardDocument;
  if (!document) {
    return {
      surface: {
        availability: "available",
        disabledReason: null,
        surfaceOpen: false,
        token: null,
        url: null,
        documentId: null,
        documentTitle: null,
      },
    };
  }

  const closed = {
    surface: {
      availability: "available" as const,
      disabledReason: null,
      surfaceOpen: false,
      token: null,
      url: null,
      documentId: document.whiteboardId,
      documentTitle: document.title,
    },
  };
  if (!document.surfaceOpen) return closed;
  const placement = await placeBoard(createDb(env.DB), env, document.syncRoomId, {
    kind: "meeting",
    meetingId: params.meetingId,
    mediaNodeId: params.mediaNodeId,
  });
  if (!placement) return closed;
  const whiteboardRoomId = toWhiteboardRoomId(document.syncRoomId);

  const whiteboardToken = await createWhiteboardJWT(placement.node.jwtKeyring, {
    sub: params.participantIdentity,
    name: params.participantName,
    role: params.participantRole,
    capabilities: params.participantCapabilities,
    sid: whiteboardRoomId,
    connectionId: params.connectionId,
    grantPrincipal: params.grantPrincipal,
    documentId: document.whiteboardId,
    generation: placement.generation,
  });

  setWhiteboardAssetCookies(
    [params.meetingId, document.syncRoomId, document.whiteboardId],
    whiteboardToken,
    { appUrl: env.APP_URL, environment: env.ENVIRONMENT },
  );

  return {
    surface: {
      availability: "available",
      disabledReason: null,
      surfaceOpen: true,
      token: whiteboardToken,
      url: placement.node.whiteboardUrl,
      documentId: document.whiteboardId,
      documentTitle: document.title,
    },
  };
}

export async function getWhiteboardRecorderCustomBaseUrl(
  env: Env,
  meetingId: string,
  options: {
    livekitUrl?: string | null;
    livekitToken?: string | null;
    meetingCode?: string | null;
    egressMode?: "recording" | "streaming" | null;
  } = {},
): Promise<string | undefined> {
  if (!isWhiteboardConfigured(env)) return undefined;

  // Issued even before the Meeting presents a board: the recorder follows
  // whichever one it presents, from its room state, and each exchange of
  // this token names the node holding that board. The URL here is only where
  // to start: the whiteboard of the node recording.
  const recorderBootstrapToken = await createRecorderBootstrapToken(env, meetingId);
  const nodes = whiteboardNodes(env);
  const recording = [...mediaNodes(env).values()].find((node) => node.url === options.livekitUrl);
  const whiteboardUrl = (nodes.find((node) => node.id === recording?.id) ?? nodes[0]).whiteboardUrl;

  logInfo("[whiteboard] Issued recorder bootstrap token", {
    meetingId,
  });

  return buildRecorderUrl(env.APP_URL, whiteboardUrl, recorderBootstrapToken, {
    livekitUrl: options.livekitUrl,
    livekitToken: options.livekitToken,
    egressMode: options.egressMode,
    meetingCode: options.meetingCode,
  });
}

export async function clearWhiteboardMeetingCookies(env: Env, meetingId: string): Promise<void> {
  const document = await findMeetingWhiteboardDocument(createDb(env.DB), meetingId);
  const scopeIds = document ? [meetingId, document.syncRoomId, document.whiteboardId] : [meetingId];
  for (const scopeId of new Set(scopeIds)) {
    clearWhiteboardAssetCookie(scopeId, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    });
  }
}

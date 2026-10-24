/**
 * Server implementations behind the RPC declarations in `./meeting-actions.functions.ts`.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import { meetingWhiteboardPages } from "@orbmeet/db/schema";
import { sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { parseWhiteboardGrantPrincipalKey, whiteboardGrantPrincipalKey } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import { createWhiteboardJWT } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { setWhiteboardAssetCookies } from "@/modules/whiteboards/server/cookies";
import { logWarn } from "@/lib/logger";
import type { AuthFnContext, RequestFnContext } from "@/app/bootstrap/middleware";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { assertPastMeetingManager } from "@/modules/meetings/server/access/access-assertions";
import { ensureMeetingWhiteboardDocument, findMeetingWhiteboardDocument } from "@/modules/whiteboards/server/documents";
import { isWhiteboardCaptureConfigured, retryFailedWhiteboardCaptures } from "@/modules/whiteboards/server/meeting/capture";
import { callCoordinator, requestSubject } from "@/modules/meetings/server/runtime/client.server";
import { newCommandId, runSyncCommand, sendSyncCommand } from "@/modules/whiteboards/server/sync-commands.server";
import { resolveActiveWhiteboardCallerIdentity } from "@/modules/whiteboards/server/service.server";
import { placeBoard } from "@/modules/whiteboards/server/board-placement.server";
import { isWhiteboardConfigured } from "./config.server";
import { setMeetingSurface } from "@/modules/whiteboards/server/surface-state.server";
import type { AddWhiteboardPageInput, DenyWhiteboardEditAccessInput, GetWhiteboardTokenInput, GrantWhiteboardEditAccessInput, RecordWhiteboardPageEditInput, ReleaseWhiteboardNavigationControllerInput, RequestWhiteboardEditAccessInput, RetryWhiteboardCaptureInput, SetWhiteboardNavigationControllerInput, SetWhiteboardSurfaceStateInput, RecordWhiteboardPagePresentedInput } from "./meeting-actions.functions";

type WhiteboardCallerInput = { meetingId: string; connectionId?: string };
type WhiteboardBoardCallerInput = WhiteboardCallerInput & { whiteboardId?: string };

type WhiteboardCaller = Awaited<ReturnType<typeof resolveActiveWhiteboardCallerIdentity>> &
  Pick<RequestFnContext, "db" | "env">;

type WhiteboardDocumentCaller = WhiteboardCaller & {
  whiteboardRoomId: ReturnType<typeof toWhiteboardRoomId>;
  whiteboardDocument: NonNullable<Awaited<ReturnType<typeof findMeetingWhiteboardDocument>>>;
};

async function resolveWhiteboardDocument(db: Database, meetingId: string) {
  const document = await findMeetingWhiteboardDocument(db, meetingId);
  if (!document) throw Errors.NOT_FOUND("Whiteboard");
  return document;
}

/** The caller behind a request that reads or writes the Meeting's surface state. */
async function resolveWhiteboardCaller(
  rateLimitPrefix: string,
  data: WhiteboardCallerInput,
  context: RequestFnContext,
): Promise<WhiteboardCaller> {
  const caller = await resolveActiveWhiteboardCallerIdentity(
    context,
    data.meetingId,
    data.connectionId,
    rateLimitPrefix,
  );
  return { ...caller, db: context.db, env: context.env };
}

/**
 * `resolveWhiteboardCaller` plus the Meeting's presented whiteboard and its
 * live room. An action that names a board is refused once the Meeting
 * presents another: it was meant for the board the caller was looking at.
 */
async function resolveWhiteboardDocumentCaller(
  rateLimitPrefix: string,
  data: WhiteboardBoardCallerInput,
  context: RequestFnContext,
): Promise<WhiteboardDocumentCaller> {
  const caller = await resolveWhiteboardCaller(rateLimitPrefix, data, context);
  const whiteboardDocument = await resolveWhiteboardDocument(caller.db, caller.meeting.id);
  if (data.whiteboardId !== undefined && data.whiteboardId !== whiteboardDocument.whiteboardId) {
    throw Errors.CONFLICT("The Meeting is presenting another Whiteboard");
  }
  return {
    ...caller,
    whiteboardDocument,
    whiteboardRoomId: toWhiteboardRoomId(whiteboardDocument.syncRoomId),
  };
}

async function recordMeetingWhiteboardPage(
  db: Database,
  meetingWhiteboardId: string,
  pageId: string,
  kind: "presented" | "edited",
): Promise<void> {
  const now = new Date();
  await db
    .insert(meetingWhiteboardPages)
    .values({
      meetingWhiteboardId,
      pageId,
      firstPresentedAt: kind === "presented" ? now : null,
      firstEditedAt: kind === "edited" ? now : null,
    })
    .onConflictDoUpdate({
      target: [meetingWhiteboardPages.meetingWhiteboardId, meetingWhiteboardPages.pageId],
      set:
        kind === "presented"
          ? {
              firstPresentedAt: sql`coalesce(${meetingWhiteboardPages.firstPresentedAt}, excluded.first_presented_at)`,
            }
          : {
              firstEditedAt: sql`coalesce(${meetingWhiteboardPages.firstEditedAt}, excluded.first_edited_at)`,
            },
    });
}

/** How long a token mint waits for the board to open; see getWhiteboardTokenImpl. */
const OPEN_ON_TOKEN_TIMEOUT_MS = 5_000;

export async function getWhiteboardTokenImpl({
  data,
  context,
}: {
  data: GetWhiteboardTokenInput;
  context: RequestFnContext;
}) {
  const { env, db, user } = context;
  if (!isWhiteboardConfigured(env)) {
    throw Errors.CONFIG_ERROR("Whiteboard not configured");
  }
  const { meeting, callerIdentity } = await resolveActiveWhiteboardCallerIdentity(
    context,
    data.meetingId,
    data.connectionId,
    "whiteboard:token",
  );
  // Deliberately no live /health probe here. This handler is also the whiteboard
  // reconnect path; refusing to mint a JWT because /health briefly timed out
  // strands an otherwise recoverable board. Actual server down/version skew is
  // handled by the WebSocket adapter and sync protocol after the token exists.
  const document = await findMeetingWhiteboardDocument(db, meeting.id);
  if (!document || document.status !== "active") {
    throw Errors.CONFLICT("The shared Whiteboard surface is closed");
  }

  // The board goes where the Meeting's media is, unless another live Meeting
  // has it on its own node.
  const placement = await placeBoard(db, env, document.syncRoomId, {
    kind: "meeting",
    meetingId: meeting.id,
    mediaNodeId: meeting.mediaNodeId,
  });
  if (!placement) throw Errors.CONFLICT("The shared Whiteboard surface is closed");
  const whiteboardRoomId = toWhiteboardRoomId(document.syncRoomId);
  // Give a new board its first page before any token exposes it, as the
  // standalone document page does; otherwise the host's browser creates it,
  // racing anything the server adds meanwhile. Best effort and brief: this is
  // also the reconnect path, and a board the server cannot open now is one
  // the socket will not reach either, so the client's own retry covers it.
  const opened = await sendSyncCommand(env, "open", {
    whiteboardRoomId,
    whiteboardId: document.whiteboardId,
    commandId: newCommandId(),
  }, { timeoutMs: OPEN_ON_TOKEN_TIMEOUT_MS, target: placement });
  if (!opened.ok) {
    logWarn("[whiteboard] could not open the meeting board before minting its token", {
      meetingId: meeting.id,
      reason: opened.reason,
    });
  }
  const token = await createWhiteboardJWT(placement.node.jwtKeyring, {
    sub: callerIdentity.identity,
    name: callerIdentity.displayName || (user ? user.name || user.email : null) || "User",
    role: callerIdentity.role,
    capabilities: callerIdentity.capabilities,
    sid: whiteboardRoomId,
    connectionId: callerIdentity.connectionId,
    grantPrincipal: callerIdentity.grantPrincipal,
    documentId: document.whiteboardId,
    generation: placement.generation,
  });

  setWhiteboardAssetCookies([meeting.id, document.syncRoomId, document.whiteboardId], token, {
    appUrl: env.APP_URL,
    environment: env.ENVIRONMENT,
  });

  return {
    token,
    whiteboardUrl: placement.node.whiteboardUrl,
    documentId: document.whiteboardId,
    documentTitle: document.title,
  };
}

export async function requestWhiteboardEditAccessImpl({
  data,
  context,
}: {
  data: RequestWhiteboardEditAccessInput;
  context: RequestFnContext;
}) {
  const { env, whiteboardRoomId, callerIdentity } = await resolveWhiteboardDocumentCaller(
    "whiteboard:edit-access-request",
    data,
    context,
  );
  const { user } = context;
  const { status } = await runSyncCommand(env, "editRequest", {
    whiteboardRoomId,
    principalKey: whiteboardGrantPrincipalKey(callerIdentity.grantPrincipal),
    userId: callerIdentity.identity,
    userName: callerIdentity.displayName || (user ? user.name || user.email : null),
  });
  return { success: true, status };
}

export async function grantWhiteboardEditAccessImpl({
  data,
  context,
}: {
  data: GrantWhiteboardEditAccessInput;
  context: RequestFnContext;
}) {
  const { db, env, meeting, whiteboardRoomId, callerIdentity } =
    await resolveWhiteboardDocumentCaller("whiteboard:edit-access-grant", data, context);
  const principal = parseWhiteboardGrantPrincipalKey(data.targetPrincipalKey);
  if (!principal) {
    throw Errors.VALIDATION("Invalid whiteboard grant principal");
  }
  // The Meeting's coordinator decides: it checks the caller may moderate and
  // the target is admitted, records the grant on the admission, and tells the
  // presented board's room, which moves the grantee onto an editing token.
  const subject = await requestSubject(db, meeting.id, context.user, { attemptId: callerIdentity.connectionId });
  await callCoordinator(env, {
    kind: "command",
    meetingId: meeting.id,
    command: { kind: "grantBoardEdit", subject, principal },
  });
  // The room clears the pending request it showed the moderators.
  const { status } = await runSyncCommand(env, "editResolve", {
    whiteboardRoomId,
    targetPrincipalKey: data.targetPrincipalKey,
    approverId: callerIdentity.identity,
    outcome: "approved",
  });
  return { success: true, status };
}

export async function denyWhiteboardEditAccessImpl({
  data,
  context,
}: {
  data: DenyWhiteboardEditAccessInput;
  context: RequestFnContext;
}) {
  const { env, whiteboardRoomId, callerIdentity } = await resolveWhiteboardDocumentCaller(
    "whiteboard:edit-access-deny",
    data,
    context,
  );
  if (!callerIdentity.capabilities.canManageWhiteboard) {
    throw Errors.FORBIDDEN();
  }
  if (!parseWhiteboardGrantPrincipalKey(data.targetPrincipalKey)) {
    throw Errors.VALIDATION("Invalid whiteboard grant principal");
  }
  const { status } = await runSyncCommand(env, "editResolve", {
    whiteboardRoomId,
    targetPrincipalKey: data.targetPrincipalKey,
    approverId: callerIdentity.identity,
    outcome: "denied",
  });
  return { success: true, status };
}

/**
 * Open the shared surface for everyone, or close it. The Meeting's room owns
 * the surface; a first open only makes sure the Meeting has a Whiteboard to
 * show before asking it.
 */
export async function setWhiteboardSurfaceStateImpl({
  data,
  context,
}: {
  data: SetWhiteboardSurfaceStateInput;
  context: RequestFnContext;
}) {
  const { db, env, meeting, callerIdentity } = await resolveWhiteboardCaller(
    "whiteboard:surface-state-write",
    data,
    context,
  );
  // The room decides; this only keeps an attendee from creating a board.
  if (!callerIdentity.capabilities.canControlSurface) {
    throw Errors.FORBIDDEN();
  }
  const fallback = data.open
    ? await ensureMeetingWhiteboardDocument(
        db,
        env,
        meeting.id,
        callerIdentity.grantPrincipal.type === "user" ? callerIdentity.grantPrincipal.id : null,
        { clientTimeZone: data.clientTimeZone },
      )
    : null;
  if (data.open && !fallback) throw Errors.NOT_FOUND("Whiteboard");
  const subject = await requestSubject(db, meeting.id, context.user, {
    attemptId: callerIdentity.connectionId,
  });
  return setMeetingSurface(env, meeting.id, subject, data.open, fallback);
}

export async function setWhiteboardNavigationControllerImpl({
  data,
  context,
}: {
  data: SetWhiteboardNavigationControllerInput;
  context: RequestFnContext;
}) {
  const { env, whiteboardRoomId, callerIdentity } = await resolveWhiteboardDocumentCaller(
    "whiteboard:navigation-controller-set",
    data,
    context,
  );
  if (!callerIdentity.capabilities.canManageWhiteboard) {
    throw Errors.FORBIDDEN();
  }
  const { status, navigationControllerUserId } = await runSyncCommand(
    env,
    "navigationControllerSet",
    { whiteboardRoomId, targetUserId: data.targetUserId, approverId: callerIdentity.identity },
  );
  return { success: true, status, navigationControllerUserId };
}

export async function releaseWhiteboardNavigationControllerImpl({
  data,
  context,
}: {
  data: ReleaseWhiteboardNavigationControllerInput;
  context: RequestFnContext;
}) {
  const { env, whiteboardRoomId, callerIdentity } = await resolveWhiteboardDocumentCaller(
    "whiteboard:navigation-controller-release",
    data,
    context,
  );
  const { status } = await runSyncCommand(env, "navigationControllerRelease", {
    whiteboardRoomId,
    requesterId: callerIdentity.identity,
  });
  return { success: true, status };
}

/**
 * Records a page the Meeting's presenter showed the room. The presenter's
 * client writes the room's navigation itself (a document record the room
 * holds to its active navigator) and reports each page it presents here; the
 * room confirms the caller drives its navigation and that the page is one of
 * its own before the page is recorded.
 */
export async function recordWhiteboardPagePresentedImpl({
  data,
  context,
}: {
  data: RecordWhiteboardPagePresentedInput;
  context: RequestFnContext;
}) {
  const { db, env, whiteboardDocument, whiteboardRoomId, callerIdentity } =
    await resolveWhiteboardDocumentCaller("whiteboard:page-presented", data, context);
  // Only someone who can edit the board can drive its navigation; the room
  // decides whether this caller is the one driving.
  if (!callerIdentity.capabilities.canControlSurface && !callerIdentity.capabilities.canEditWhiteboard) {
    throw Errors.FORBIDDEN();
  }
  await runSyncCommand(env, "pagePresentValidate", {
    whiteboardRoomId,
    userId: callerIdentity.identity,
    connectionId: callerIdentity.connectionId,
    pageId: data.pageId,
  });
  await recordMeetingWhiteboardPage(db, whiteboardDocument.meetingWhiteboardId, data.pageId, "presented");
  return { recorded: true };
}

/** Records at most one local edit marker per page and client session. */
export async function recordWhiteboardPageEditImpl({
  data,
  context,
}: {
  data: RecordWhiteboardPageEditInput;
  context: RequestFnContext;
}) {
  const { db, env, whiteboardDocument, whiteboardRoomId, callerIdentity } =
    await resolveWhiteboardDocumentCaller("whiteboard:page-edit", data, context);
  // "This page was edited" is only true of someone who can edit the whiteboard.
  // View-only participants reach this server fn like any other active
  // participant, so the capability — not merely being connected — is the gate.
  if (!callerIdentity.canEditWhiteboard) {
    throw Errors.FORBIDDEN();
  }
  await runSyncCommand(env, "pageEditValidate", {
    whiteboardRoomId,
    userId: callerIdentity.identity,
    connectionId: callerIdentity.connectionId,
    pageId: data.pageId,
  });
  await recordMeetingWhiteboardPage(
    db,
    whiteboardDocument.meetingWhiteboardId,
    data.pageId,
    "edited",
  );
  return { recorded: true };
}

export async function addWhiteboardPageImpl({
  data,
  context,
}: {
  data: AddWhiteboardPageInput;
  context: RequestFnContext;
}) {
  const { env, whiteboardRoomId, callerIdentity } = await resolveWhiteboardDocumentCaller(
    "whiteboard:page-add",
    data,
    context,
  );
  if (!callerIdentity.canEditWhiteboard) {
    throw Errors.FORBIDDEN();
  }
  const { status, page } = await runSyncCommand(env, "pageAdd", {
    whiteboardRoomId,
    userId: callerIdentity.identity,
    connectionId: callerIdentity.connectionId,
    afterPageNumber: data.afterPageNumber,
  });
  return { success: true, status, page };
}

/** Manager-initiated recovery for bounded Meeting Whiteboard capture retries. */
export async function retryWhiteboardCaptureImpl({
  data,
  context: { env, db, user },
}: {
  data: RetryWhiteboardCaptureInput;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `whiteboard:capture-retry:${user.id}`);

  const meeting = await assertPastMeetingManager(db, data.meetingId, user.id);
  if (meeting.status !== "ended") {
    throw Errors.VALIDATION("Only an ended Meeting can retry Whiteboard capture");
  }

  if (!isWhiteboardCaptureConfigured(env)) {
    throw Errors.CONFIG_ERROR("Whiteboard capture is not configured");
  }
  if (!(await retryFailedWhiteboardCaptures(db, env, meeting.id))) {
    throw Errors.VALIDATION("This Meeting does not have a recoverable Whiteboard capture");
  }
  return { captureState: "capturing" as const };
}

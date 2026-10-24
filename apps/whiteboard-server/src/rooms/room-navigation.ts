import { createRoomNavigation, type RoomNavigationRecord } from "@orbmeet/whiteboard-core/room-navigation";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { syncCommandFailure, type SyncCommandResult } from "@orbmeet/whiteboard-core/sync-commands";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { canEditWhiteboardForMeta, isBaseManager } from "./room-authority.ts";
import type { LiveConnection } from "./room-connections.ts";
import { logInfo } from "../lib/log.ts";

/** What navigation needs from the room around it. */
export interface RoomNavigationHost {
  whiteboardRoomId: WhiteboardRoomId;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string | null): void;
  liveConnections(): LiveConnection[];
  canManageWhiteboard(userId: string): boolean;
  stateChanged(): void;
}

/**
 * The navigation controller, held as a grant principal rather than a session's
 * user id: a Meeting participant's user id names one join, and a rejoin — a
 * reload, a network handover — mints a new one. Control belongs to the person,
 * so it survives both a rejoin and a sync-server restart; the room resolves it
 * to whichever of their live sessions may edit.
 */
const CONTROLLER_META_KEY = "navigationControllerPrincipal";

/**
 * Where the room's spotlight was kept before navigation became a document
 * record. A room opened with them still set carries them over once
 * (`readLegacyNavigation`).
 */
const LEGACY_SPOTLIGHT_META_KEYS = [
  "spotlightPageId",
  "spotlightPageNumber",
  "spotlightPageCount",
  "spotlightRev",
  "spotlightRect",
  "spotlightPresenterId",
  "spotlightRoam",
] as const;

/**
 * Who drives the room's navigation.
 *
 * Where the room is lives in the document, as the navigation record its
 * presenter writes (`RoomNavigationRecord`); the room's authorizer lets only
 * the active navigator write it. That navigator is a whiteboard manager,
 * unless a manager handed control to another participant: the navigation
 * controller, persisted by principal.
 */
export class RoomNavigation {
  private controllerPrincipalKey: string | null;

  private readonly host: RoomNavigationHost;

  constructor(host: RoomNavigationHost) {
    this.host = host;
    // A persisted controller who never returns is cleared the first time a
    // manager drives navigation (`navigated`).
    this.controllerPrincipalKey = host.getMeta(CONTROLLER_META_KEY);
  }

  /**
   * The live session the navigation controller drives through: one of the
   * controlling principal's sessions that still holds Whiteboard edit access.
   *
   * While the principal has no such session the controller is simply absent:
   * nobody is shown presenting and managers drive, until they return.
   * Checking edit access here, not only at handoff, is what keeps a controller
   * who lost it from driving on their return. Side-effect free: an
   * unauthorized request must not be able to clear persisted state.
   */
  activeController(): LiveConnection | null {
    const principalKey = this.controllerPrincipalKey;
    if (principalKey === null) return null;
    return this.host.liveConnections().find(
      ({ meta }) => meta.grantPrincipalKey === principalKey && canEditWhiteboardForMeta(meta),
    ) ?? null;
  }

  /** Whether `userId` is a live session of the active navigation controller. */
  private isController(userId: string): boolean {
    const principalKey = this.controllerPrincipalKey;
    return principalKey !== null && this.host.liveConnections().some(
      ({ meta }) =>
        meta.userId === userId
        && meta.grantPrincipalKey === principalKey
        && canEditWhiteboardForMeta(meta),
    );
  }

  /** The controller drives while one is active; otherwise a manager does. */
  isActiveNavigator(userId: string): boolean {
    return this.activeController() ? this.isController(userId) : this.host.canManageWhiteboard(userId);
  }

  setController(targetUserId: string, approverId: string): SyncCommandResult<"navigationControllerSet"> {
    if (!this.host.canManageWhiteboard(approverId)) {
      return syncCommandFailure("forbidden", "Only whiteboard managers can assign navigation control");
    }

    // Driving navigation requires Whiteboard edit access — `activeController`
    // enforces that on every use, so accepting a handoff without it produced a
    // room that named a presenter, told every client so, and then routed all
    // navigation back to the manager. The handoff has to fail loudly instead.
    const targetConnections = this.host.liveConnections().filter(({ meta }) => meta.userId === targetUserId);
    if (targetConnections.length === 0) {
      return syncCommandFailure("not_found", "Target user is not connected");
    }
    const targetSession = targetConnections.find(({ meta }) => canEditWhiteboardForMeta(meta));
    if (!targetSession) {
      return syncCommandFailure("conflict", "Grant whiteboard edit access before handing over presenting");
    }
    const targetPrincipal = targetSession.meta.grantPrincipalKey;
    if (
      this.host.liveConnections().some(
        ({ meta }) => meta.userId === approverId && meta.grantPrincipalKey === targetPrincipal,
      )
    ) {
      return syncCommandFailure("invalid", "Cannot hand off presenting to yourself");
    }

    this.persistController(targetPrincipal);
    this.host.stateChanged();
    return { ok: true, status: "navigation_controller_set", navigationControllerUserId: targetUserId };
  }

  releaseController(requesterId: string): SyncCommandResult<"navigationControllerRelease"> {
    // Live sockets, not tldraw's session list (which lags disconnects by ~5s)
    // — the same connections basis every other authority check uses.
    const isAuthorized = this.host.liveConnections().some(
      ({ meta }) =>
        meta.userId === requesterId &&
        (isBaseManager(meta) || meta.grantPrincipalKey === this.controllerPrincipalKey),
    );
    if (!isAuthorized) {
      return syncCommandFailure(
        "forbidden",
        "Only whiteboard managers or the current navigation controller can release navigation control",
      );
    }
    this.persistController(null);
    this.host.stateChanged();
    return { ok: true, status: "navigation_controller_released" };
  }

  /**
   * `userId` has just moved the room's navigation. A persisted controller who
   * is not here to drive has lost it: the room was driven without them, and
   * coming back must not take it from whoever drove meanwhile.
   */
  navigated(userId: string): void {
    if (!this.controllerPrincipalKey || this.activeController()) return;
    this.persistController(null);
    this.host.stateChanged();
    logInfo(`[Room ${this.host.whiteboardRoomId}] Released an absent navigation controller: ${userId} drove navigation`);
  }

  /**
   * The navigation a page add or import writes with its pages, when the user
   * who made it drives the room's navigation: everyone moves to the new page.
   * Null for anyone else, who goes there alone.
   */
  navigationForPageMutation(
    current: RoomNavigationRecord | undefined,
    target: { pageId: string; pageNumber: number },
    userId: string,
  ): RoomNavigationRecord | null {
    if (!this.isActiveNavigator(userId)) return null;
    return {
      ...(current ?? createRoomNavigation()),
      pageId: target.pageId,
      pageNumber: Math.min(WHITEBOARD_CONFIG.MAX_PAGES, Math.max(1, Math.trunc(target.pageNumber))),
      presenterId: userId,
      // Roam is the presenter's call; a new presenter starts with everyone following.
      roam: current?.presenterId === userId ? current.roam : false,
    };
  }

  /**
   * The navigation a room kept in its metadata before navigation was a
   * document record, if it still holds any. The room writes it as the record
   * once, then `clearLegacyNavigation`.
   */
  readLegacyNavigation(): RoomNavigationRecord | null {
    const pageId = this.host.getMeta("spotlightPageId");
    if (!pageId) return null;
    const pageNumber = Number(this.host.getMeta("spotlightPageNumber"));
    return createRoomNavigation({
      pageId,
      pageNumber: Number.isSafeInteger(pageNumber)
        ? Math.min(WHITEBOARD_CONFIG.MAX_PAGES, Math.max(1, pageNumber))
        : 1,
      presenterId: this.host.getMeta("spotlightPresenterId") || null,
      roam: this.host.getMeta("spotlightRoam") === "true",
    });
  }

  clearLegacyNavigation(): void {
    for (const key of LEGACY_SPOTLIGHT_META_KEYS) {
      if (this.host.getMeta(key) !== null) this.host.setMeta(key, null);
    }
  }

  private persistController(principalKey: string | null): void {
    this.controllerPrincipalKey = principalKey;
    this.host.setMeta(CONTROLLER_META_KEY, principalKey);
  }
}

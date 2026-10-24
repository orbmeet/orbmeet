import {
  TLSyncErrorCloseEventReason,
  type TLSocketRoom,
} from "@tldraw/sync-core";
import type { RoomSnapshot } from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";
import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import type { SessionMeta, TldrawSocket, SocketSession } from "./room-types.ts";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { syncCommandFailure, type SyncCommandResult } from "@orbmeet/whiteboard-core/sync-commands";
import type { AssistantEvent } from "@orbmeet/whiteboard-core/assistant";
import { RoomEditRequests } from "./room-edit-requests.ts";
import { RoomConnections } from "./room-connections.ts";
import { RoomNavigation } from "./room-navigation.ts";
import {
  RoomPageCommands,
  type ImportedPagesApplyResult,
  type ImportedPdfPageSpec,
} from "./room-page-commands.ts";
import { RoomMessageGuard } from "./room-message-guard.ts";
import { RoomPresenceLane } from "./room-presence-lane.ts";
import { ROOM_NAVIGATION_ID, type RoomNavigationRecord } from "@orbmeet/whiteboard-core/room-navigation";
import { roomRecordAuthorizers } from "./room-record-authorizers.ts";
import { assertValidRoomRecord, isValidRoomRecord } from "./record-rules.ts";
import { shapeAuthorOf } from "@orbmeet/whiteboard-core/shape-author";
import { attachLooseShapesToPages } from "@orbmeet/whiteboard-core/page-frame-model";
import type { SnapshotStore } from "../persistence/snapshot-store.ts";
import { RoomDocument } from "./room-document.ts";
import type { AuthorityValidator } from "../http/authority-client.ts";
import { RoomAuthority, canEditWhiteboardForMeta, isBaseManager } from "./room-authority.ts";
import { RoomBroadcaster } from "./room-broadcaster.ts";
import { RoomAssistant } from "../assistant/room-assistant.ts";
import type { AssistantModel } from "../assistant/assistant-model.ts";
import { Reply } from "../http/reply.ts";
import { logError, logInfo, logWarn } from "../lib/log.ts";

export interface RoomDependencies {
  snapshots: SnapshotStore;
  authority: AuthorityValidator;
  /** Known from the admitting token or command; otherwise read from the room database. */
  whiteboardId?: string | null;
  /** The first state of a board whose database does not exist yet. */
  initialSnapshot?: RoomSnapshot;
  /** Null when the server has no model configured. */
  assistantModel?: AssistantModel | null;
}

export class Room {
  /** The board: its database, tldraw room and the Worker's commands on it. */
  readonly document: RoomDocument;
  private readonly sync: TLSocketRoom<TLRecord, SessionMeta>;
  /** Who drives the room's navigation. */
  readonly navigation: RoomNavigation;
  readonly assistant: RoomAssistant;
  /** Who may do what, and the Worker's verdicts on it. */
  readonly authority: RoomAuthority;
  /** Sockets, rate limits, and what holds the room open. */
  readonly connections: RoomConnections;
  private readonly broadcaster: RoomBroadcaster;
  private readonly messageGuard: RoomMessageGuard;
  private readonly presence: RoomPresenceLane;
  private readonly editRequests: RoomEditRequests;
  private readonly pageCommands: RoomPageCommands;
  private closed = false;

  readonly whiteboardRoomId: WhiteboardRoomId;
  private onEmpty: () => void;

  constructor(
    whiteboardRoomId: WhiteboardRoomId,
    dataDir: string,
    onEmpty: () => void,
    dependencies: RoomDependencies,
  ) {
    this.whiteboardRoomId = whiteboardRoomId;
    this.onEmpty = onEmpty;
    this.document = new RoomDocument(
      whiteboardRoomId,
      `${dataDir}/${whiteboardRoomId}.db`,
      dependencies.snapshots,
      {
        beginOperation: () => this.connections.beginOperation(),
        endOperation: () => this.connections.endOperation(),
        disconnectAll: () => this.connections.revokeAll(TLSyncErrorCloseEventReason.FORBIDDEN),
        documentReplaced: () => {
          this.attachLoosePageContent();
          this.messageGuard.noteServerSnapshotReplacement();
        },
        ensureInitialPage: () => this.pageCommands.ensureInitialPage(),
        recordAuthorizers: roomRecordAuthorizers({
          roomLabel: whiteboardRoomId,
          sessionMeta: (sessionId) => this.connections.meta(sessionId),
          canAcceptMutations: () => this.document.canAcceptMutations(),
          isActiveNavigator: (userId) => this.navigation.isActiveNavigator(userId),
        }),
      },
      { whiteboardId: dependencies.whiteboardId, initialSnapshot: dependencies.initialSnapshot },
    );
    this.sync = this.document.sync;
    // Reading the spotlight and the page frames can still throw on a corrupt
    // database. Nothing before here owns a timer, so the document is all there
    // is to release.
    try {
      this.navigation = new RoomNavigation({
        whiteboardRoomId,
        getMeta: this.document.store.getMeta,
        setMeta: this.document.store.setMeta,
        liveConnections: () => this.connections.live(),
        canManageWhiteboard: (userId) => this.authority.canManageWhiteboard(userId),
        stateChanged: () => this.broadcastWhiteboardState(),
      });
      this.authority = new RoomAuthority({
        whiteboardRoomId,
        validator: dependencies.authority,
        generation: () => this.document.generation,
        liveConnections: () => this.connections.live(),
        sessionMetas: () => this.connections.allMetas(),
        sessionMeta: (tldrawSessionId) => this.connections.meta(tldrawSessionId),
        isClosed: () => this.closed,
        reconnect: (tldrawSessionId) => this.connections.reconnect(tldrawSessionId),
        deny: (tldrawSessionId) => this.connections.revoke(tldrawSessionId, TLSyncErrorCloseEventReason.FORBIDDEN),
        disconnectAll: () => this.connections.revokeAll(TLSyncErrorCloseEventReason.UNKNOWN_ERROR),
        stateChanged: () => this.broadcastWhiteboardState(),
      });
      this.messageGuard = new RoomMessageGuard({
        whiteboardRoomId,
        getSnapshot: () => this.sync.getCurrentSnapshot(),
        getRecord: (id) => this.sync.getRecord(id),
        getSessionMeta: (tldrawSessionId) => this.connections.meta(tldrawSessionId),
        canEditWhiteboardForMeta,
        canAcceptDocumentMutations: () => this.document.canAcceptMutations(),
        sendCustomMessage: (tldrawSessionId, data) => this.connections.send(tldrawSessionId, data),
        discardPush: (tldrawSessionId, clientClock) =>
          this.sync.handleSocketMessage(
            tldrawSessionId,
            JSON.stringify({
              type: "push",
              clientClock,
              diff: {},
            }),
          ),
        onRoomSizeRecovered: () => {
          this.broadcaster.broadcastToLiveConnections({
            type: WHITEBOARD_EVENTS.ROOM_SIZE_RECOVERED,
            maxBytes: WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES,
          });
          this.broadcastWhiteboardState();
        },
        closeSession: (tldrawSessionId, reason) => this.connections.closeOffending(tldrawSessionId, reason),
        closeSessionTransiently: (tldrawSessionId) => this.connections.closeTransiently(tldrawSessionId),
      });
      this.editRequests = new RoomEditRequests({
        liveConnections: () => this.connections.live(),
        isBaseManager,
        canEditWhiteboardForMeta,
        canManageWhiteboard: (userId) => this.authority.canManageWhiteboard(userId),
        sendCustomMessage: (sessionId, data) => this.connections.send(sessionId, data),
        broadcastState: () => this.broadcastWhiteboardState(),
        refreshAuthority: () => this.authority.refresh(),
      });
      this.pageCommands = new RoomPageCommands(whiteboardRoomId, {
        runTransaction: (operation) =>
          this.sync.storage.transaction((transaction) => operation(transaction)).result,
        canAddPages: (userId) => this.canUserAddPages(userId),
        canReplaceExistingPage: (userId) => this.authority.canManageWhiteboard(userId),
        navigationForPageMutation: (current, target, userId) =>
          this.navigation.navigationForPageMutation(current, target, userId),
        navigated: (userId) => this.navigation.navigated(userId),
        getEstimatedRoomBytes: () => this.messageGuard.getEstimatedRoomBytes(),
        verifyRoomSizeEstimate: () => this.messageGuard.verifyRoomSizeEstimate(),
        noteMutationBytes: (byteLength) => this.messageGuard.noteServerMutationBytes(byteLength),
        notePageFramesChanged: () => this.messageGuard.noteServerPageFrameMutation(),
      });
      this.attachLoosePageContent();
      this.adoptLegacyNavigation();
    } catch (error) {
      this.document.close();
      throw error;
    }

    // Nothing from here on reads persisted state.
    this.presence = new RoomPresenceLane({
      reserveFanout: (userId, bytes) => this.connections.reservePresenceFanout(userId, bytes),
      requestResync: (tldrawSessionId) =>
        this.connections.send(tldrawSessionId, { type: WHITEBOARD_EVENTS.PRESENCE_RESYNC }),
    });
    this.connections = new RoomConnections({
      whiteboardRoomId,
      sync: this.sync,
      sessionAdded: (tldrawSessionId) => this.messageGuard.addSession(tldrawSessionId),
      sessionRemoved: (tldrawSessionId) => {
        this.messageGuard.deleteSession(tldrawSessionId);
        this.presence.deleteSession(tldrawSessionId);
      },
      connectionEnded: (connectionId) => this.assistant.connectionEnded(connectionId),
      stateChanged: (connectionsChanged) => this.broadcastWhiteboardState(connectionsChanged),
      idle: () => {
        try {
          this.close();
        } catch (error) {
          logError(`[Room ${this.whiteboardRoomId}] Failed to close after idle cleanup:`, error);
        } finally {
          this.vacateSlot();
        }
      },
    });
    this.assistant = new RoomAssistant(
      {
        whiteboardRoomId,
        broadcast: (event) => this.broadcaster.broadcastToLiveConnections(event),
        sendToUsers: (userIds, event) => this.sendToUsers(userIds, event),
        sendToConnection: (connectionId, event) => this.sendToConnection(connectionId, event),
        presentName: (userId) => this.connections.live().find(({ meta }) => meta.userId === userId)?.meta.userName ?? null,
        canEdit: (userId) => this.authority.canUserEditWhiteboard(userId),
        canManage: (userId) => this.authority.canManageWhiteboard(userId),
      },
      dependencies.assistantModel ?? null,
    );
    this.broadcaster = new RoomBroadcaster({
      whiteboardRoomId,
      liveConnections: () => this.connections.live(),
      sendToSession: (sessionId, data) => this.connections.send(sessionId, data),
      authority: this.authority,
      collectStateInputs: () => ({
        editorPrincipalKeys: this.authority.grantedEditorPrincipalKeys(),
        pendingEditorRequests: this.editRequests.list(),
        roomSizeLimited: this.messageGuard.isRoomSizeLimited(),
        navigationControllerUserId: this.navigation.activeController()?.meta.userId ?? null,
        navigationControllerName: this.navigation.activeController()?.meta.userName ?? null,
      }),
    });
  }

  // Adding pages mutates the shared document, so it requires canvas-edit
  // access (moderator or a granted editor). View-only participants
  // must not be able to insert pages.
  canUserAddPages(userId: string): boolean {
    if (!this.document.canAcceptMutations()) return false;
    if (this.authority.canManageWhiteboard(userId)) return true;
    return this.connections.live().some(
      ({ meta }) => meta.userId === userId && canEditWhiteboardForMeta(meta),
    );
  }

  /**
   * Put content from before everything was kept on a page — an older board,
   * a restored revision — onto the page it belongs to, once, as the document
   * is opened or replaced. From then on, moving pages moves everything.
   *
   * Moving a shape never makes it less valid, but a board can hold one the
   * schema refuses today. That one stays where it is: writing it would send
   * every client a record none can apply (see `assertValidRoomRecord`), and
   * refusing the whole move would leave the board unable to open.
   */
  private attachLoosePageContent(): void {
    if (!this.document.isWritable) return;
    const { attached, refused } = this.sync.storage.transaction((transaction) => {
      const shapes = attachLooseShapesToPages([...transaction.values()] as TLRecord[]);
      const valid = shapes.filter(isValidRoomRecord);
      for (const shape of valid) transaction.set(shape.id, shape);
      return { attached: valid.length, refused: shapes.length - valid.length };
    }).result;
    if (attached > 0) logInfo(`[Room ${this.whiteboardRoomId}] Put ${attached} loose shape(s) on their pages`);
    if (refused > 0) logWarn(`[Room ${this.whiteboardRoomId}] Left ${refused} loose shape(s) the schema refuses where they are`);
  }

  /**
   * A room that kept its navigation in metadata, from before navigation was
   * a document record, writes it as the record once — unless the document
   * already has one — and forgets the old keys.
   */
  private adoptLegacyNavigation(): void {
    if (!this.document.isWritable) return;
    const legacy = this.navigation.readLegacyNavigation();
    if (legacy) {
      this.sync.storage.transaction((transaction) => {
        if (transaction.get(ROOM_NAVIGATION_ID)) return;
        assertValidRoomRecord(legacy);
        transaction.set(legacy.id, legacy);
      });
    }
    this.navigation.clearLegacyNavigation();
  }

  private sendToUsers(userIds: readonly string[], event: AssistantEvent): void {
    for (const { tldrawSessionId, meta } of this.connections.live()) {
      if (userIds.includes(meta.userId)) this.connections.send(tldrawSessionId, event);
    }
  }

  private sendToConnection(connectionId: string, event: AssistantEvent): number {
    let sent = 0;
    for (const { tldrawSessionId, meta } of this.connections.live()) {
      if (meta.connectionId !== connectionId) continue;
      this.connections.send(tldrawSessionId, event);
      sent += 1;
    }
    return sent;
  }

  handleConnect(ws: TldrawSocket, data: SocketSession): void {
    if (!this.document.isWritable) {
      ws.close(1012, "whiteboard document lifecycle changing");
      return;
    }
    // A token for another whiteboard is refused, or the session would carry
    // the wrong document id into every asset check.
    if (data.documentId && !this.document.bindWhiteboard(data.documentId)) {
      ws.close(1008, "Token is for a different whiteboard");
      return;
    }
    this.connections.connect(ws, data);
  }

  handleMessage(tldrawSessionId: string, message: string | Uint8Array): void {
    if (this.closed) return;
    const sessionMeta = this.connections.meta(tldrawSessionId);
    const userId = sessionMeta?.userId ?? tldrawSessionId;
    if (!this.connections.admitIngress(tldrawSessionId, userId, message)) return;

    const decision = this.messageGuard.evaluate(tldrawSessionId, message);
    if (!decision.accept || decision.forward === null) {
      return;
    }

    // The guard's reassembly, not the raw frame: a chunked message reaches
    // TLSyncRoom only once whole and approved. Its presence goes on as the
    // presence lane decides — whole, as an operation, or not at all — while the
    // rest of the push, and the client clock it carries, always does.
    const { message: admitted, presence } = decision.forward;
    const forwardedPresence = presence && this.presence.forward(tldrawSessionId, userId, presence);
    this.sync.handleSocketMessage(
      tldrawSessionId,
      JSON.stringify(forwardedPresence ? { ...admitted, presence: forwardedPresence } : admitted),
    );
    // The push has now merged: presence is already inside this session's
    // retained record, so this is the earliest point the retained ceiling can
    // be measured against reality.
    if (forwardedPresence) {
      this.connections.enforcePresenceCeilings(tldrawSessionId, userId);
    }
    // Read only records touched by the accepted diff, keeping the page-frame
    // index synchronous.
    this.messageGuard.recordAcceptedMessage(decision);
    // A presenter's move that landed: one by a manager while the persisted
    // controller is away releases them.
    if (decision.touchesNavigation && this.readNavigation()?.presenterId === userId) {
      this.navigation.navigated(userId);
    }
    // Applying the connect request is what promotes the session from
    // AwaitingConnectMessage to Connected (TLSyncRoom.handleConnectRequest),
    // and only a Connected session receives custom messages. This is the
    // earliest point at which the new client can be told its write access —
    // a broadcast from handleConnect would be silently dropped.
    if (decision.isConnectRequest) {
      this.broadcastWhiteboardState(true);
    }
  }

  handleClose(tldrawSessionId: string, code: number, ws?: TldrawSocket, reason?: string): void {
    this.connections.handleClose(tldrawSessionId, code, ws, reason);
  }

  isClosed(): boolean {
    return this.closed;
  }

  private vacateSlot(): void {
    try {
      this.onEmpty();
    } catch (error) {
      logError(`[Room ${this.whiteboardRoomId}] Failed to vacate room slot:`, error);
    }
  }

  close(): void {
    if (this.closed) return; // Guard against double-close
    this.closed = true;

    logInfo(`[Room ${this.whiteboardRoomId}] Cleanup: closing room and database`);
    for (const [name, release] of [
      ["connections", () => this.connections.close()],
      ["presence", () => this.presence.clear()],
      ["edit requests", () => this.editRequests.clear()],
      ["assistant", () => this.assistant.close()],
      ["message guard", () => this.messageGuard.clearSessions()],
      ["database", () => this.document.close()],
    ] as const) {
      try {
        release();
      } catch (error) {
        logError(`[Room ${this.whiteboardRoomId}] Failed to clean up ${name}:`, error);
      }
    }
  }

  isEmpty(): boolean {
    return this.connections.isEmpty();
  }

  /** The board is being deleted: disconnect everyone for good and release the database. */
  closeForPurge(): void {
    this.connections.revokeAll(TLSyncErrorCloseEventReason.NOT_FOUND);
    this.close();
  }

  private broadcastWhiteboardState(connectionsChanged = false): void {
    this.broadcaster.broadcastWhiteboardState(connectionsChanged);
  }

  // ─── Live commands ─────────────────────────────────────────────────────

  editRequest(
    principalKey: string,
    userId: string,
    userName: string | null,
  ): SyncCommandResult<"editRequest"> {
    return this.editRequests.request(principalKey, userId, userName);
  }

  editResolve(
    targetPrincipalKey: string,
    approverId: string,
    outcome: "approved" | "denied",
  ): SyncCommandResult<"editResolve"> {
    return this.editRequests.resolve(targetPrincipalKey, approverId, outcome);
  }

  addPage(userId: string, afterPageNumber?: number): SyncCommandResult<"pageAdd"> {
    const result = this.pageCommands.addPage(userId, afterPageNumber);
    if (!result.ok) return result;
    if (result.status === "already_initialized") {
      // addPage never runs in initialize-only mode; this arm exists for the type.
      return syncCommandFailure("conflict", "No page was added");
    }
    return result;
  }

  private readNavigation(): RoomNavigationRecord | null {
    return (this.sync.getRecord(ROOM_NAVIGATION_ID) as RoomNavigationRecord | undefined) ?? null;
  }

  /**
   * Whether a client may record `pageId` as presented: it drives the room's
   * navigation, from a live connection, and the page is on the board.
   */
  validatePresentedPageFromClient(
    userId: string,
    connectionId: string,
    pageId: string,
  ): SyncCommandResult<"pagePresentValidate"> {
    const caller = this.connections.live().some(
      ({ meta }) => meta.userId === userId && meta.connectionId === connectionId,
    );
    if (!caller || !this.navigation.isActiveNavigator(userId)) {
      return syncCommandFailure("forbidden", "Only the presenter can record presented pages");
    }
    if (!this.messageGuard.hasPageFrame(pageId)) {
      return syncCommandFailure("not_found", "Whiteboard page not found");
    }
    return { ok: true, status: "page_present_validated" };
  }

  validateEditedPageFromClient(
    userId: string,
    connectionId: string,
    pageId: string,
  ): SyncCommandResult<"pageEditValidate"> {
    const caller = this.connections.live().find(
      ({ meta }) => meta.userId === userId && meta.connectionId === connectionId,
    );
    if (!caller || !canEditWhiteboardForMeta(caller.meta)) {
      return syncCommandFailure("forbidden", "Only a connected Whiteboard editor can record page edits");
    }
    if (!this.messageGuard.hasPageFrame(pageId)) {
      return syncCommandFailure("not_found", "Whiteboard page not found");
    }
    return { ok: true, status: "page_edit_validated" };
  }

  // Server-side PDF import application. Page frames are privileged mutations, and
  // the imported page image must never be separated from its frame; create both
  // in one authoritative storage transaction.
  insertImportedPages(
    userId: string,
    spec: {
      importId: string;
      insertIndex: number;
      pages: ImportedPdfPageSpec[];
      reuse?: { frameId: string; height: number };
      after?: { pageIndex: number };
    },
  ): ImportedPagesApplyResult {
    // The request reads its JSON body before applying. Shutdown or the idle
    // reaper may close the captured room during that await; return a retryable
    // verdict instead of touching a closed SQLite transaction and surfacing an
    // opaque 500.
    if (this.closed) {
      return {
        reply: Reply.json(
          { error: "Whiteboard room is no longer available" },
          409,
        ),
        placedPageIndices: [],
      };
    }
    // The import request names only the user; their display name is on the
    // connection they imported from. If every one of their tabs has closed
    // since, the pages go in without an author rather than a made-up name.
    const importer = [...this.connections.allMetas()].find((meta) => meta.userId === userId);
    return this.pageCommands.insertImportedPages(userId, {
      ...spec,
      author: importer ? shapeAuthorOf(importer.userId, importer.userName) : null,
    });
  }

  canUserEditWhiteboard(userId: string): boolean {
    return this.authority.canUserEditWhiteboard(userId);
  }

}

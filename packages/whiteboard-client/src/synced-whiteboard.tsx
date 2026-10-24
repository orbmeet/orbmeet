import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  type ReactNode,
  type Ref,
} from "react";
import {
  Tldraw,
  type Editor,
  type TLStore,
  type TLUiAssetUrlOverrides,
  type TLUser,
  useValue,
} from "tldraw";
import { GlowLaserOverlayUtil, GlowCollaboratorLaserOverlayUtil } from "./toolbar/glow-laser-overlay";
import { useWhiteboardSync } from "./sync/use-whiteboard-sync";
import type { WhiteboardConnectAttempt } from "./sync/whiteboard-socket-adapter";
import { WhiteboardToolbarContext } from "./toolbar/whiteboard-toolbar-context";
import { isShowingSources, setShowingSources } from "./sources/show-sources-state";
import { WhiteboardPageRail } from "./pages/whiteboard-page-rail";
import { useWhiteboardPageThumbnails } from "./pages/use-page-thumbnails";
import { WhiteboardViewportControls } from "./camera/whiteboard-viewport-controls";
import type { WhiteboardFollowState } from "./camera/whiteboard-follow";
import { SelectionAsk } from "./assistant/selection-ask";
import type { AssistantHost } from "./assistant/use-assistant";
import { useWhiteboardPages } from "./pages/use-whiteboard-pages";
import { useWhiteboardPageDialogs } from "./pages/use-whiteboard-page-dialogs";
import { useWhiteboardPageAddRequests } from "./pages/use-whiteboard-page-add-requests";
import type { AddWhiteboardPageFn as AddWhiteboardPageFunction } from "./pages/use-whiteboard-page-add-requests";
import type { WhiteboardToastFn } from "./chrome/whiteboard-toast";
import { usePageImagePreloader } from "./pages/use-page-image-preloader";
import { buildWhiteboardConnectUrl } from "./sync/service-endpoints";
import { installCanvasTransformGuard } from "./editor/install-canvas-transform-guard";
import {
  WhiteboardCanvasSlotsContext,
  WhiteboardConnectFailure,
  whiteboardComponents,
  type WhiteboardCanvasSlotsValue,
} from "./editor/whiteboard-canvas-components";
import type { WhiteboardClientCapabilities } from "./editor/client-capabilities";
import { StrokeEraserTool } from "./toolbar/stroke-eraser-tool";
import { ScreenshotTool } from "./toolbar/screenshot-tool";
import { TableTool } from "./shapes/table/table-tool";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { shapeAuthorOf } from "@orbmeet/whiteboard-core/shape-author";
import { border, danger, neutral, surface, violet, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { spinner } from "@orbmeet/ui/styles/animations";
import { withBoardClass } from "./styles/board";
import * as stylex from "@stylexjs/stylex";
import {
  whiteboardControlsBandPx,
  WHITEBOARD_PAGE_RAIL_BAND_PX,
  WHITEBOARD_PAGE_RAIL_WIDTH_PX,
  WHITEBOARD_TOOLBAR_HEIGHT,
} from "./camera/viewport-insets";
import {
  controlsPlacement,
  DEFAULT_WHITEBOARD_CHROME,
  type WhiteboardChromeConfig,
} from "./chrome/whiteboard-chrome";
import {
  whiteboardShapeUtils,
  whiteboardSyncShapeUtils,
} from "./editor/whiteboard-shapes";
import { useWhiteboardIdentity } from "./sync/use-whiteboard-identity";
import {
  createPresenceActivity,
  presenceWhileActive,
} from "./sync/presence-activity";
import {
  useWhiteboardAssetStore,
  type UploadFileFn,
} from "./assets/use-whiteboard-asset-store";
import { useAssetImageRetry } from "./assets/use-asset-image-retry";
import { useWhiteboardImageImport } from "./assets/use-whiteboard-image-import";
import { WhiteboardAccessOverlays } from "./chrome/whiteboard-access-overlays";
import { Sparkles } from "lucide-react";
import { useCommittedRef } from "@orbmeet/ui/react";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";
import { useWhiteboardEditorLifecycle } from "./editor/use-whiteboard-editor-lifecycle";
import { useWhiteboardEditorSetup } from "./editor/use-whiteboard-editor-setup";
import { useWhiteboardRoomState } from "./sync/use-whiteboard-room-state";
import { useBoardHostNotifications } from "./sync/use-board-host-notifications";
import { useBoardChrome } from "./chrome/use-board-chrome";
import { useRoomNavigation } from "./camera/use-room-navigation";
import { WHITEBOARD_RECORD_SCHEMAS } from "@orbmeet/whiteboard-core/room-schema";
import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import { readPageTarget } from "@orbmeet/whiteboard-core/sync-commands";
import { useBoardAssistant } from "./assistant/use-board-assistant";
import { createRoomChannel } from "./sync/room-channel";
import type { RoomMessage } from "@orbmeet/whiteboard-core/room-messages";

// Stable arrays — defined outside component to prevent tldraw remount
const whiteboardTools = [StrokeEraserTool, ScreenshotTool, TableTool];
const LazyAssistantPanel = lazy(async () => {
  const module = await import("./assistant/assistant-panel");
  return { default: module.AssistantPanel };
});

installCanvasTransformGuard();

const styles = stylex.create({
  /** The board's own stacking context — see the note at the document root. */
  document: {
    position: "relative",
    isolation: "isolate",
    height: "100%",
    width: "100%",
    touchAction: "none",
    /**
     * The desk, published as a custom property because `whiteboard-canvas.css`
     * paints it too, and a static stylesheet cannot name a hashed StyleX
     * variable; the toolbar and page rail read the same property. Declaring it
     * here rather than in the `style` object below keeps it on the themeable
     * token instead of a literal.
     */
    "--wb-document-bg": surface.board,
    backgroundColor: "var(--wb-document-bg)",
    // Paper on a desk in every theme: the board, its toolbar and its page rail
    // stay light even when the room around them is dark, so a drawing looks
    // the same to everyone in it.
    colorScheme: "light",
  },

  /**
   * A notice strip riding on the board's top edge.
   *
   * One geometry, three grounds — one definition, so the strip keeps a single
   * radius.
   */
  notice: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    paddingInline: space.s4,
    paddingBlock: space.s2,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    boxShadow: shadows.popover,
  },
  noticeTop: {
    top: "calc(var(--whiteboard-toolbar-offset, 0px) + 1rem)",
    zIndex: boardZIndex.notice,
  },
  noticeBelow: { top: space.s16, zIndex: boardZIndex.notice },
  noticeStatusSlot: {
    top: "calc(var(--whiteboard-toolbar-offset, 0px) + 1rem)",
    zIndex: boardZIndex.status,
  },
  noticeWarning: {
    borderColor: warning.w300,
    backgroundColor: warning.w50,
    color: warning.w950,
  },
  noticeDanger: {
    borderColor: danger.d300,
    backgroundColor: danger.d50,
    color: danger.d800,
  },
  noticeQuiet: {
    borderColor: neutral.n300,
    backgroundColor: surface.raised,
    color: neutral.n700,
  },

  /** "Opening whiteboard…" — shown both before and after the store exists. */
  loadingGround: {
    position: "relative",
    height: "100%",
    width: "100%",
    overflow: "hidden",
    backgroundColor: surface.board,
  },
  loadingOverlay: {
    position: "absolute",
    inset: 0,
    zIndex: boardZIndex.overlay,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: surface.board,
  },
  loadingCentre: {
    position: "relative",
    display: "flex",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.s6,
  },
  loadingCapsule: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${border.strong} 70%, transparent)`,
    backgroundColor: glass.solid,
    paddingInline: space.s5,
    paddingBlock: space.s3,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: neutral.n700,
    boxShadow: shadows.popover,
  },
  loadingCapsuleGlass: {
    backgroundColor: glass.panel,
    backdropFilter: "blur(4px)",
  },

  /** The canvas starts to the right of the page rail rather than under it. */
  canvasSlot: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    zIndex: 0,
    left: "var(--wb-page-rail-band, 0px)",
  },
  /**
   * The ground under a regular board's top controls. The page lands with its
   * top just under them, so the end of the page before it would otherwise
   * show through the band as a stray white strip behind the capsules.
   */
  controlsBand: {
    position: "absolute",
    top: 0,
    right: 0,
    left: "var(--wb-page-rail-band, 0px)",
    zIndex: boardZIndex.sources,
    height: "var(--wb-controls-band)",
    backgroundColor: surface.board,
    pointerEvents: "none",
  },

  /** The read-only board's AI launcher. */
  aiLauncher: {
    position: "absolute",
    zIndex: boardZIndex.action,
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: violet.v200,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": violet.v50 } },
    fontFamily: "inherit",
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.medium,
    color: violet.v700,
    boxShadow: shadows.lift1,
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
  },
  aiLauncherCompact: { right: space.s2_5, top: space.s2_5, height: space.s8, paddingInline: space.s2_5 },
});

export type { UploadFileFn } from "./assets/use-whiteboard-asset-store";

/** A PDF already filed in the Space, offered as an insertable source file. */
export interface PdfLibraryFile {
  id: string;
  filename: string;
  size: number;
  createdAt: string;
}

/**
 * The Space's Files, injected by the host app.
 *
 * Insert PDF reads from here so a document imported once can be inserted again
 * next week by name instead of being re-uploaded from disk, and so the source
 * PDF survives an import at all — rasterization discards it. The package cannot
 * reach the Space's files itself, so the app supplies listing and upload.
 */
export interface PdfLibrary {
  list: () => Promise<PdfLibraryFile[]>;
  /** File a newly chosen PDF in the Space, returning its durable id. */
  save: (file: File) => Promise<{ fileId: string }>;
}
export type AddWhiteboardPageFn = AddWhiteboardPageFunction;

export interface SyncedWhiteboardHandle {
  /** Presenter-only: make the page they are on the room's, now. False when this participant does not present. */
  presentCurrentPage: () => boolean;
}

export interface SyncedWhiteboardProps {
  ref?: Ref<SyncedWhiteboardHandle>;
  capabilities: WhiteboardClientCapabilities;
  licenseKey?: string;
  whiteboardUrl: string;
  /** Stable board identity used for document-scoped local caches. */
  documentId?: string;
  token: string;
  getWebSocketUri?: (attempt: WhiteboardConnectAttempt) => Promise<string>;
  assetUrls?: TLUiAssetUrlOverrides;
  uploadFile?: UploadFileFn;
  /** Space Files for Insert PDF. Absent falls back to upload-from-disk only. */
  pdfLibrary?: PdfLibrary;
  resolveAssetUrl?: (src: string) => string;
  onRequestEditAccess?: () => Promise<{ status?: string } | void>;
  chrome?: WhiteboardChromeConfig;
  onStatusChange?: (status: "loading" | "ready" | "fatal") => void;
  onConnectionStatusChange?: (status: "online" | "offline") => void;
  onContentStateChange?: (hasContent: boolean) => void;
  onEditorReady?: (editor: Editor | null) => void;
  aiEnabled?: boolean;
  /**
   * Shows the assistant's conversation in the host's UI instead of the
   * board's panel; the board's assistant button then asks the host to show it.
   */
  assistantHost?: AssistantHost;
  /**
   * The board follows a presenter: the navigation controller, else a manager,
   * whose page turns everyone else is carried along by. A Meeting's board
   * does; a document opened on its own is read by each person on their own.
   */
  presents?: boolean;
  /** A page this participant, presenting, has just made the room's: for the host to record. */
  onPagePresented?: (pageId: string) => void;
  /**
   * Who this participant's view is following, and the way to stop or start.
   * `null` while there is nobody to follow (this client presents, or nobody
   * else presenting is on the board). Host chrome — the meeting's command
   * palette — offers the same choice the board's own pill does.
   */
  onFollowStateChange?: (state: WhiteboardFollowState | null) => void;
  onAddPage?: AddWhiteboardPageFn;
  /** Manager-only: designate a connected participant as the active navigation controller */
  onSetNavigationController?: (targetUserId: string) => Promise<void>;
  /**
   * Manager-only: give a participant edit access, by grant principal. Handing
   * the board to someone who cannot write yet does this first.
   */
  onGrantEditAccess?: (principalKey: string) => Promise<void>;
  /** Manager or current navigation controller: release navigation control */
  onReleaseNavigationController?: () => Promise<void>;
  /** Receives every message the room sends outside tldraw's sync, after the board has read it. */
  onCustomMessage?: (message: RoomMessage) => void;
  /** Host toaster. Required for notifications to be visible under `hideUi`. */
  onToast?: WhiteboardToastFn;
  /**
   * Host-owned UI that must participate in the whiteboard's local overlay
   * stack. Rendered inside the isolated surface so its `--z-board-*` token is
   * compared with board chrome, panels, and modals rather than app-level
   * dialogs and toasts.
   */
  surfaceOverlay?: ReactNode;
  readOnlySurface?: boolean;
}

export interface PendingEditorAccessRequest {
  principalKey: string;
  userId: string;
  userName: string;
}

/**
 * A board synced with the whiteboard server: the canvas, its toolbar and
 * page rail, and the socket that keeps it live. It knows nothing of meetings
 * or documents; the host decides which board, for whom, and supplies the
 * application's routes (the web app's `MeetingWhiteboard` wraps it for a
 * meeting, the document page uses it directly, `RecorderWhiteboard` for the
 * recorder).
 *
 * Reconnects are split by what they need. This layer's socket adapter
 * retries the connection itself, with jittered backoff, until a close it
 * treats as permanent. Each attempt asks the host for its URI
 * (`getWebSocketUri`), and the host owns the credentials: the web app's
 * `WhiteboardSession` mints a fresh token per attempt, retries a failed mint,
 * and decides whether the board should be open at all.
 */
export function SyncedWhiteboard({
  ref,
  capabilities,
  licenseKey,
  whiteboardUrl,
  documentId,
  token,
  getWebSocketUri,
  assetUrls,
  uploadFile,
  pdfLibrary,
  resolveAssetUrl,
  onRequestEditAccess,
  chrome: whiteboardChrome = DEFAULT_WHITEBOARD_CHROME,
  onStatusChange,
  onConnectionStatusChange,
  onContentStateChange,
  onEditorReady,
  aiEnabled,
  assistantHost,
  presents = false,
  onPagePresented,
  onFollowStateChange,
  onAddPage,
  onSetNavigationController,
  onGrantEditAccess,
  onReleaseNavigationController,
  onCustomMessage,
  onToast,
  surfaceOverlay,
  readOnlySurface = false,
}: SyncedWhiteboardProps) {
  const { editor, setEditor } = useWhiteboardEditorLifecycle({
    onEditorReady,
  });

  const { identity, directory } = useWhiteboardIdentity(token);
  const users = directory?.users;
  const isHost = identity.isHost;
  // Stable ref for the latest token for asset resolution and other
  // auth-dependent side channels outside the websocket handshake.
  const tokenRef = useCommittedRef(token);
  // The assistant runs on the sync server; the host decides whether to offer it.
  const agentEnabled = !!aiEnabled;

  // Nobody has a resting cursor. See `presence-activity` for why this is tied
  // to activity rather than to edit permission.
  const presenceActivity = useMemo(() => createPresenceActivity(), []);
  useEffect(() => () => presenceActivity.dispose(), [presenceActivity]);
  const getUserPresence = useCallback(
    (store: TLStore, user: TLUser) => presenceWhileActive(presenceActivity, store, user),
    [presenceActivity],
  );
  const handlePresencePointerDown = useCallback(() => presenceActivity.begin(), [presenceActivity]);
  const handlePresencePointerUp = useCallback(() => presenceActivity.end(), [presenceActivity]);

  // Everything the room sends outside tldraw's sync, for every reader below.
  const channel = useMemo(() => createRoomChannel(), []);
  const {
    actionError: whiteboardActionError,
    canEditWhiteboard,
    connectedUsers,
    editAccessRequested,
    navigationControllerName,
    navigationControllerUserId,
    reportActionError: reportWhiteboardActionError,
    requestEditAccess,
    roomSizeLimited,
  } = useWhiteboardRoomState({
    channel,
    isHost,
    userId: identity.userId,
    onRequestEditAccess,
  });

  const wsUrl = useCallback(async (attempt: WhiteboardConnectAttempt) => {
    if (getWebSocketUri) return getWebSocketUri(attempt);
    return buildWhiteboardConnectUrl(whiteboardUrl, tokenRef.current);
  }, [getWebSocketUri, tokenRef, whiteboardUrl]);
  const assetStore = useWhiteboardAssetStore({ uploadFile, resolveAssetUrl });
  const sync = useWhiteboardSync({
    uri: wsUrl,
    assets: assetStore,
    shapeUtils: whiteboardSyncShapeUtils,
    records: WHITEBOARD_RECORD_SCHEMAS,
    users,
    getUserPresence,
    onCustomMessageReceived: channel.receive,
  });
  const syncReady = sync.status === "synced-remote";
  const isLoading = sync.status === "loading";
  const isError = sync.status === "error" || identity.error !== null;
  const syncOnline = sync.status === "synced-remote" && sync.connectionStatus === "online";

  // Editor writability is the single authority for every edit affordance. The
  // sync layer owns `isReadonly`, projecting the server's per-connection edit
  // decision through a reactive signal (see docs/tldraw/sdk-features/readonly.mdx).
  // Because drawing and the toolbar now read the same signal, they cannot
  // diverge — the class of "can draw but no toolbar" bug is gone.
  const editorIsReadonly = useValue(
    "whiteboard editor readonly",
    () => editor?.getIsReadonly() ?? true,
    [editor]
  );
  const canEdit = !!editor && !editorIsReadonly;
  const canMutateWhiteboard = canEdit && syncOnline;
  // Announced as an editor by the capability broadcast, but the writable
  // (re)connection hasn't landed yet — the brief window after an approval.
  const editAccessSyncing = canEditWhiteboard && !canEdit;

  const { canvasChrome, togglePageRail, setControlsHeightPx } = useBoardChrome({
    chrome: whiteboardChrome,
    readOnlySurface,
    hasTools: canEdit || canEditWhiteboard || isHost,
  });
  const isCompactChrome = canvasChrome.mode === "compact";

  // The navigation controller drives everyone's page while there is one;
  // otherwise the whiteboard's managers do, and they alone hand it off.
  // Active participants may add pages; manager-only controls are kept for
  // navigation authority plus destructive/import/resize page-frame actions.
  const isNavigationController =
    navigationControllerUserId !== null && navigationControllerUserId === identity.userId;
  const isPresenter = navigationControllerUserId !== null ? isNavigationController : isHost;
  const canManageNavigationController = isHost;
  const canManagePages = canManageNavigationController;
  // Adding pages mutates the shared document, so it is gated on canvas-edit
  // access. View-only participants get neither the add controls nor the
  // pull-to-add trailing buffer.
  const canAutoCreatePages =
    syncReady && canMutateWhiteboard && (!!onAddPage || canManagePages);

  const wb = useWhiteboardPages({
    editor,
    chrome: canvasChrome,
    syncReady,
    canManagePages,
    canAutoCreatePages,
  });
  const { navigator } = wb;
  const pageManager = navigator?.pageManager ?? null;
  // Read lazily (at prompt time, on paste) by hooks generic over the page model.
  const pageManagerRef = useCommittedRef(pageManager);

  useBoardHostNotifications({
    editor,
    channel,
    status: isError
      ? "fatal"
      : syncReady && wb.pages.length > 0 && wb.initialCameraReady
        ? "ready"
        : "loading",
    connectionStatus: syncOnline ? "online" : "offline",
    onStatusChange,
    onConnectionStatusChange,
    onContentStateChange,
    onCustomMessage,
  });

  const presenting = useRoomNavigation({
    editor,
    navigator,
    myUserId: identity.userId,
    isPresenter,
    presents,
    onPagePresented,
    onFollowStateChange,
  });
  const { turnPage, showOwnPage } = presenting;

  // The room dropped a presence update of this client's: change its presence
  // once, which the room forwards whole, so peers are back in step.
  useEffect(
    () => channel.on(WHITEBOARD_EVENTS.PRESENCE_RESYNC, () => presenceActivity.resync()),
    [channel, presenceActivity],
  );

  // Where `resolve` reads presence from, once sync has made the store.
  const syncStore = sync.status === "synced-remote" ? sync.store : null;
  useEffect(() => {
    directory?.store.set(syncStore);
  }, [directory, syncStore]);

  const {
    assistant,
    showsPanel: showsAssistantPanel,
    panelOpen: isAiPanelOpen,
    togglePanel: toggleAssistant,
  } = useBoardAssistant({
    channel,
    enabled: agentEnabled,
    whiteboardUrl,
    tokenRef,
    userId: identity.userId,
    editor,
    pages: wb,
    pageManagerRef,
    canManageWhiteboard: isHost,
    syncReady,
    syncOnline,
    canDraw: canMutateWhiteboard,
    followedPresenterRef: presenting.followedPresenterRef,
    stopFollowingOnOwnMove: presenting.stopFollowingOnOwnMove,
    host: assistantHost,
  });

  const pageDialogs = useWhiteboardPageDialogs({
    editor,
    pages: wb.pages,
    currentPage: wb.currentPage,
    canEditWhiteboard: canMutateWhiteboard,
    canManagePages,
    commitDeletePage: wb.commitDeletePage,
  });

  // Not before the board has its first page. The server creates it when the
  // board opens; should that fail, the host's client creates it during the
  // first fit, and a page added on the server meanwhile would take the same
  // first-page id, so the add would land on that page and vanish.
  const canAddPages =
    syncReady &&
    canMutateWhiteboard &&
    wb.pages.length > 0 &&
    wb.pages.length < WHITEBOARD_CONFIG.MAX_PAGES &&
    (!!onAddPage || canManagePages);

  usePageImagePreloader(editor, wb.pages, wb.currentPage, resolveAssetUrl);
  useAssetImageRetry(editor);

  // Pictures for the page rail. Rendered only while the rail is on screen —
  // a compact board has no rail, and rasterising fifty pages for a list nobody
  // can see is the kind of work that only shows up as a warm phone.
  const pageThumbnails = useWhiteboardPageThumbnails({
    editor,
    pages: wb.pages,
    currentPage: wb.currentPage,
    enabled: canvasChrome.pageRailVisible,
    // The board's identity, for the cross-session raster cache: reopening a
    // 24-page document should show 24 pictures, not 24 empty rectangles while
    // the render queue works through them one at a time.
    whiteboardUrl,
    documentId,
    resolveAssetUrl,
  });

  // The token's user, as new shapes record them. The room holds it to the
  // same identity, so a stamp from here is never rewritten.
  const shapeAuthor = identity.userId ? shapeAuthorOf(identity.userId, identity.userName) : null;
  const showingSources = useValue("showing sources", () => (editor ? isShowingSources(editor) : false), [editor]);
  useWhiteboardEditorSetup({
    editor,
    uploadFile,
    disableCoalescedPointerEvents:
      capabilities.disableCoalescedPointerEvents,
    whiteboardUrl,
    tokenRef,
    canEdit,
    syncReady,
    pageManagerRef,
    onActionError: reportWhiteboardActionError,
    author: shapeAuthor,
  });

  // The room added the page; this participant goes to it, presenting or not.
  const applyAddedPageResponse = useCallback(
    (response: unknown) => {
      const page = readPageTarget((response as { page?: unknown } | null | undefined)?.page);
      if (page) showOwnPage(page);
    },
    [showOwnPage]
  );

  const {
    isAddingPage,
    addPage: addPageAndSync,
    insertPageAfter: insertPageAfterAndSync,
  } = useWhiteboardPageAddRequests({
    canManagePages,
    syncReady,
    onAddPage,
    applyAddedPageResponse,
    addPageLocally: wb.addPage,
    insertPageAfterLocally: wb.insertPageAfter,
  });
  const canRequestAddPages = canAddPages && !isAddingPage;

  // Adding a page is two operations, kept where each one reads. A bare "+"
  // appends: the rail's foot button and pull-to-create both sit past the last
  // page, and appending renumbers nothing for the rest of the room. Inserting
  // is positional — the rail's between-thumbnail carets — or, in the toolbar,
  // relative to the page you are looking at.
  const insertPageAfterCurrentAndSync = useCallback(() => {
    insertPageAfterAndSync(navigator?.currentPage.get() ?? 1);
  }, [navigator, insertPageAfterAndSync]);

  const toolbarContextValue = useMemo(
    () => ({
      pageManager,
      onPagesChanged: wb.onPagesChanged,
      currentPage: wb.currentPage,
      pages: wb.pages,
      onAddPage: canRequestAddPages ? insertPageAfterCurrentAndSync : undefined,
      onInsertPageAfter: canRequestAddPages ? insertPageAfterAndSync : undefined,
      onClearPage: pageDialogs.clearPage,
      onPageChange: turnPage,
      canEditWhiteboard: canMutateWhiteboard,
      canManagePages,
      uploadFile,
      pdfLibrary,
      getVisibleViewportCenter: () =>
        navigator?.cameraConstraints.getVisibleViewportCenter() ?? null,
      isCompactChrome,
      isPhonePortrait: canvasChrome.isMeetingPhonePortrait,
      aiEnabled: showsAssistantPanel,
      isAiPanelOpen,
      onToggleAi: toggleAssistant,
      isLoading,
      isConnected: syncOnline,
      whiteboardUrl,
      whiteboardToken: token,
      onToast,
    }),
    [
      wb.onPagesChanged,
      wb.pages,
      wb.currentPage,
      pageManager,
      canMutateWhiteboard,
      canManagePages,
      canRequestAddPages,
      insertPageAfterAndSync,
      insertPageAfterCurrentAndSync,
      pageDialogs.clearPage,
      turnPage,
      uploadFile,
      pdfLibrary,
      navigator,
      isCompactChrome,
      canvasChrome.isMeetingPhonePortrait,
      isLoading,
      syncOnline,
      isAiPanelOpen,
      toggleAssistant,
      showsAssistantPanel,
      whiteboardUrl,
      token,
      onToast,
    ]
  );

  const canvasSlotsValue = useMemo<WhiteboardCanvasSlotsValue>(
    () => ({
      canEdit,
      readerEdge: !canEdit && canvasChrome.mode === "compact" && !canvasChrome.toolbarVisible,
      pageShadows: {
        canAddPages,
        isAddingPage,
        onAddPage: addPageAndSync,
        navigator,
      },
    }),
    [addPageAndSync, canAddPages, canEdit, canvasChrome, isAddingPage, navigator]
  );

  const tldrawStore = syncStore ?? undefined;
  const showWhiteboardPreparingOverlay =
    syncReady && (wb.pages.length === 0 || !wb.initialCameraReady);

  const {
    isDraggingOver,
    handleDragOver,
    handleDragLeave,
    handleDragEnd,
    tldrawOptions,
  } = useWhiteboardImageImport({
    editor,
    canEditWhiteboard: canEdit,
    uploadFile,
    navigator,
    onPagesChanged: wb.onPagesChanged,
  });

  useImperativeHandle(
    ref,
    () => ({
      presentCurrentPage: presenting.presentCurrentPage,
    }),
    [presenting.presentCurrentPage]
  );

  if (isError) {
    return (
      <WhiteboardConnectFailure message={identity.error ?? "Failed to connect to whiteboard."} />
    );
  }

  if (!tldrawStore && isLoading) {
    return (
      <div {...stylex.props(styles.loadingGround)}>
        <div {...stylex.props(styles.loadingCentre)}>
          <div {...stylex.props(styles.loadingCapsule, styles.loadingCapsuleGlass)}>
            <div {...stylex.props(spinner.ring, spinner.neutral, spinner.md)} />
            <span>Opening whiteboard…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      // `styles.document` is static, so it contributes no inline style of its
      // own and the class alone is the whole of its contribution — which is
      // what leaves the `style` object below free to publish the variables.
      // The desk (`--wb-document-bg`) is declared in `styles.document` rather
      // than here: its value is a token, not a per-frame measurement.
      className={
        withBoardClass(
          // Board z-index tokens describe an internal stack. `isolate` (in
          // `styles.document`) is what keeps them from competing with app
          // dialogs and toasts outside this component.
          "whiteboard-document",
          styles.document,
        ).className
      }
      // Chrome measurements, published for the overlays and the stylesheet
      // that have to clear them. These change with layout, so they belong in
      // the inline style rather than in a compiled class.
      style={{
        "--whiteboard-toolbar-height": `${WHITEBOARD_TOOLBAR_HEIGHT[canvasChrome.mode]}px`,
        // A regular board keeps its top band for everyone — it holds the
        // edit-access request — so overlays clear it whether or not the reader
        // has tools. A compact board's band is its toolbar, present or not.
        "--whiteboard-toolbar-offset":
          canvasChrome.mode === "regular" || canvasChrome.toolbarVisible
            ? `${WHITEBOARD_TOOLBAR_HEIGHT[canvasChrome.mode]}px`
            : "0px",
        // The page rail's band, published for the overlays that must clear it
        // (the view controls in the corner) so the width lives in one place.
        "--wb-page-rail-band": canvasChrome.pageRailVisible
          ? `${WHITEBOARD_PAGE_RAIL_BAND_PX}px`
          : "0px",
        // The band a regular board keeps for its top controls, for the ground
        // under them: one row, or two when they wrap — the camera clears the same.
        "--wb-controls-band": `${whiteboardControlsBandPx(canvasChrome.controlsHeightPx)}px`,
        // The rail's own width, without the gap. The view controls dock inside
        // the rail on a regular board, so they need the column, not the band.
        "--wb-page-rail-width": `${WHITEBOARD_PAGE_RAIL_WIDTH_PX}px`,
      }}
      // Presence follows the pointer being down, not the pointer existing.
      // Capture phase so a stroke that starts on a shape still counts, and
      // `onLostPointerCapture` so a pointer that vanishes mid-stroke — a pen
      // leaving range, a tab switch — ends the broadcast like a normal lift.
      onPointerDownCapture={handlePresencePointerDown}
      onPointerUpCapture={handlePresencePointerUp}
      onPointerCancelCapture={handlePresencePointerUp}
      onLostPointerCapture={handlePresencePointerUp}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDragEnd={handleDragEnd}
      onDrop={handleDragEnd}
    >
      {roomSizeLimited && (
        <div
          {...stylex.props(
            styles.notice,
            styles.noticeTop,
            styles.noticeWarning,
          )}
        >
          This whiteboard reached its size limit. Delete content before adding more.
        </div>
      )}

      {whiteboardActionError && (
        <div
          role="alert"
          {...stylex.props(styles.notice, styles.noticeBelow, styles.noticeDanger)}
        >
          {whiteboardActionError}
        </div>
      )}

      {showWhiteboardPreparingOverlay && (
        <div {...stylex.props(styles.loadingOverlay)}>
          <div {...stylex.props(styles.loadingCapsule)}>
            <div {...stylex.props(spinner.ring, spinner.neutral, spinner.md)} />
            <span>Opening whiteboard…</span>
          </div>
        </div>
      )}

      <WhiteboardAccessOverlays
        isDraggingOver={isDraggingOver}
        canDropContent={canEdit}
        showClearPageDialog={pageDialogs.showClearPageDialog}
        showDeletePageDialog={pageDialogs.showDeletePageDialog}
        deletePageNumber={pageDialogs.pendingDeletePageNumber}
        currentPage={wb.currentPage}
        onCancelClearPage={() => pageDialogs.setShowClearPageDialog(false)}
        onConfirmClearPage={() => {
          pageDialogs.handleClearPageConfirmed();
          pageDialogs.setShowClearPageDialog(false);
        }}
        onCancelDeletePage={() => pageDialogs.setShowDeletePageDialog(false)}
        onConfirmDeletePage={() => {
          pageDialogs.handleDeletePageConfirmed();
          pageDialogs.setShowDeletePageDialog(false);
        }}
      />

      {editAccessSyncing && syncReady && (
        <div
          {...stylex.props(
            styles.notice,
            styles.noticeStatusSlot,
            styles.noticeQuiet,
          )}
        >
          Syncing edit access...
        </div>
      )}

      {/* Tldraw Canvas.
          It starts to the right of the page rail rather than under it. That
          offset is the whole reason the rail can exist without the board
          fighting itself: tldraw measures its own container, so the canvas
          viewport genuinely excludes the rail and every inset stays
          symmetrical. Reserving the rail as an asymmetric *camera* inset
          instead — which is how this started — meant our camera centred the
          page inside the remaining band while tldraw's own constraint solver
          re-centred it on the full container, so every page change jumped
          right and then snapped back. */}
      <div
        data-orbmeet-whiteboard-canvas
        {...stylex.props(styles.canvasSlot)}
      >
        <WhiteboardCanvasSlotsContext.Provider value={canvasSlotsValue}>
          <WhiteboardToolbarContext.Provider value={toolbarContextValue}>
            <Tldraw
              store={tldrawStore}
              onMount={setEditor}
              hideUi
              forceMobile={isCompactChrome}
              components={whiteboardComponents}
              tools={whiteboardTools}
              shapeUtils={whiteboardShapeUtils}
              users={users}
              assetUrls={assetUrls}
              options={tldrawOptions}
              overlayUtils={[GlowLaserOverlayUtil, GlowCollaboratorLaserOverlayUtil]}
              licenseKey={licenseKey}
            />
          </WhiteboardToolbarContext.Provider>
        </WhiteboardCanvasSlotsContext.Provider>
        {editor && agentEnabled && assistant.available && identity.userId && (
          <SelectionAsk
            editor={editor}
            userId={identity.userId}
            live={assistant.live}
            entries={assistant.entries}
            runs={assistant.runs}
            prompt={assistant.prompt}
          />
        )}
      </div>

      {controlsPlacement(canvasChrome) === "corner" && (
        <div aria-hidden="true" {...stylex.props(styles.controlsBand)} />
      )}

      {/* A reader on a phone has no top band to put this in, so it floats; on
          a regular board it rides at the end of the page control. */}
      {!canEdit && showsAssistantPanel && isCompactChrome && (
        <button
          type="button"
          onClick={toggleAssistant}
          {...stylex.props(styles.aiLauncher, styles.aiLauncherCompact)}
          title="Ask Orb"
        >
          <Sparkles size={14} />
          <span>Orb</span>
        </button>
      )}

      {isAiPanelOpen && (
        <Suspense fallback={null}>
          <LazyAssistantPanel
            entries={assistant.roomEntries}
            run={assistant.run}
            available={assistant.available}
            canPrompt={assistant.canPrompt}
            canCancel={assistant.canCancel}
            canClear={assistant.canClear}
            onPrompt={assistant.prompt}
            onCancel={assistant.cancel}
            onClear={assistant.clear}
            onClose={assistant.closePanel}
            isPhone={isCompactChrome}
          />
        </Suspense>
      )}

      {canvasChrome.pageRailVisible && (
        <WhiteboardPageRail
          pages={wb.pages}
          currentPage={wb.currentPage}
          canAddPages={canAddPages}
          isAddingPage={isAddingPage}
          thumbnails={pageThumbnails}
          onPageChange={turnPage}
          onAddPage={addPageAndSync}
          onInsertPageAfter={insertPageAfterAndSync}
          canDeletePages={canManagePages && !!pageDialogs.deletePage}
          onDeletePage={pageDialogs.deletePageByNumber}
        />
      )}

      <WhiteboardViewportControls
        canEditWhiteboard={canMutateWhiteboard}
        canAddPages={canAddPages}
        chrome={canvasChrome}
        onControlsHeightChange={setControlsHeightPx}
        isAddingPage={isAddingPage}
        pages={wb.pages}
        currentPage={wb.currentPage}
        zoomPercent={wb.zoomPercent}
        onPageChange={turnPage}
        onAddPage={addPageAndSync}
        onInsertPageAfter={insertPageAfterAndSync}
        onDeletePage={canManagePages ? pageDialogs.deletePage : undefined}
        onZoomIn={wb.zoomIn}
        onZoomOut={wb.zoomOut}
        onResetView={wb.resetView}
        canManageNavigation={canManageNavigationController}
        isNavigationController={isNavigationController}
        myUserId={identity.userId}
        navigationControllerName={navigationControllerName}
        connectedUsers={connectedUsers}
        onSetNavigationController={onSetNavigationController}
        onGrantEditAccess={onGrantEditAccess}
        onReleaseNavigationController={onReleaseNavigationController}
        follow={presenting.followState}
        editAccess={
          !readOnlySurface && syncReady && !canEditWhiteboard && !isHost
            ? { requested: editAccessRequested, onRequest: () => void requestEditAccess() }
            : null
        }
        presenting={presenting.presenting}
        sources={
          editor
            ? { showing: showingSources, onToggle: () => setShowingSources(editor, !showingSources) }
            : undefined
        }
        pageRailOpen={canvasChrome.pageRailVisible}
        onTogglePageRail={togglePageRail}
        ai={
          !canEdit && showsAssistantPanel
            ? {
                open: isAiPanelOpen,
                onToggle: toggleAssistant,
              }
            : undefined
        }
      />

      {surfaceOverlay}
    </div>
  );
}

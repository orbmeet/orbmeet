import * as React from "react";

import type { MeetingExtensions } from "@/modules/meetings/client/components/live-meeting-layout";
import type { LiveMeetingState } from "@/modules/meetings/client/use-live-meeting";
import type { JoinResult } from "@/modules/meetings/contract/types";
import type { MeetingSurfaceState } from "@/modules/meetings/contract/live-state";
import type { AssistantHost, AssistantView, WhiteboardFollowState } from "@orbmeet/whiteboard-client/react";
import { logError } from "@/lib/logger";
import { reportBoundaryError } from "@/lib/telemetry/client-errors";
import { markMeetingEntryMetric } from "@/modules/meetings/client/entry-metrics";
import {
  grantWhiteboardEditAccess,
  denyWhiteboardEditAccess,
} from "@/modules/whiteboards/server/meeting-actions.functions";
import type {
  MeetingWhiteboardHandle,
  PendingEditorAccessRequest,
} from "@/modules/whiteboards/client/meeting/connected-whiteboard";
import { useWhiteboardSession } from "@/modules/whiteboards/client/meeting/use-whiteboard-session";
import { useBoardRequests } from "@/modules/meetings/client/use-board-requests";
import {
  loadMeetingWhiteboardPicker,
  preloadMeetingWhiteboardModule,
} from "@/modules/whiteboards/client/meeting/preload-whiteboard";
import { isWhiteboardToggleDisabled } from "@/modules/whiteboards/client/meeting/whiteboard-toolbar-state";
import { spinner } from "@orbmeet/ui/styles/animations";
import { accent, ink, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { WHITEBOARD_TOOLBAR_HEIGHT } from "@orbmeet/whiteboard-client/viewport-insets";

const wbStyles = stylex.create({
  /** The board's own loading state, shown inside the surface it will become. */
  loading: {
    display: "flex",
    height: "100%",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: surface.raised,
  },
  centered: { textAlign: "center" },
  tile: {
    marginInline: "auto",
    marginBottom: space.s3,
    display: "flex",
    height: 48,
    width: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    backgroundImage: `linear-gradient(to bottom right, ${accent.a50}, ${accent.a100})`,
    boxShadow: `0 4px 12px -2px color-mix(in oklab, ${accent.a600} 15%, transparent)`,
  },
  caption: { margin: 0, fontSize: text.sm, fontWeight: weight.medium, color: ink.muted },
  surface: { height: "100%", width: "100%", backgroundColor: surface.raised },
});

const LazyMeetingWhiteboard = React.lazy(async () => {
  const module = await preloadMeetingWhiteboardModule();
  return { default: module.MeetingWhiteboard };
});

const LazyMeetingWhiteboardPicker = React.lazy(async () => {
  const module = await loadMeetingWhiteboardPicker();
  return { default: module.MeetingWhiteboardPicker };
});

/** The host tray's ids for this surface's two kinds of request. */
const BOARD_REQUEST_PREFIX = "whiteboard-open-";
const EDIT_REQUEST_PREFIX = "whiteboard-edit-";

class WhiteboardSurfaceErrorBoundary extends React.Component<
  {
    children: React.ReactNode;
    onError: (error: Error) => void;
  },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logError("[whiteboard] Whiteboard crashed", error, info.componentStack);
    reportBoundaryError("meeting-whiteboard", error, info.componentStack);
    this.props.onError(error);
  }

  render() {
    if (this.state.error) return null;
    return this.props.children;
  }
}

export interface UseMeetingWhiteboardParams {
  code: string;
  joinResult: JoinResult;
  meeting: LiveMeetingState;
  isAuthenticated: boolean;
}

export interface UseMeetingWhiteboardReturn {
  extensions: MeetingExtensions;
  whiteboardOpen: boolean;
}

/**
 * Whiteboard surface for the Meeting: canvas mount/loading/error states,
 * open/close toolbar wiring, and editor-access approvals. The Meeting owns the composition and passes the returned
 * extensions to LiveMeetingLayout; without them the Meeting renders unchanged.
 */
export function useMeetingWhiteboard({
  code,
  joinResult,
  meeting,
  isAuthenticated,
}: UseMeetingWhiteboardParams): UseMeetingWhiteboardReturn {
  const whiteboardRef = React.useRef<MeetingWhiteboardHandle | null>(null);
  // Whose view the board is following, as the board reports it; the meeting's
  // command palette offers the same choice as the board's own pill.
  const [whiteboardFollow, setWhiteboardFollow] = React.useState<WhiteboardFollowState | null>(null);
  const [whiteboardRequests, setWhiteboardRequests] = React.useState<
    PendingEditorAccessRequest[]
  >([]);
  const [showWhiteboardPicker, setShowWhiteboardPicker] = React.useState(false);
  // Orb is the board's: it is here while the board is mounted, and its
  // conversation is shown in the Timeline rather than on the board.
  const [orbAssistant, setOrbAssistant] = React.useState<AssistantView | null>(null);
  // What Orb said stays in the Timeline after the board closes; the board
  // brings the conversation back up to date when it opens again.
  const [orbHistory, setOrbHistory] = React.useState<AssistantView["entries"]>([]);
  const orbHost = React.useMemo<AssistantHost>(
    () => ({
      onChange: (assistant) => {
        setOrbAssistant(assistant);
        if (assistant) setOrbHistory(assistant.entries);
      },
    }),
    [],
  );

  const addToast = meeting.addToast;
  const { session, state: whiteboardState } = useWhiteboardSession(
    joinResult,
    meeting.roomInstance,
    meeting.canModerate,
  );
  const {
    token: whiteboardToken,
    wsUrl: whiteboardWsUrl,
    documentId: whiteboardDocumentId,
    documentTitle: whiteboardDocumentTitle,
    canAttemptOpen: whiteboardCanAttemptOpen,
    disabledReason: whiteboardDisabledReason,
  } = whiteboardState;
  const handleWhiteboardStatusChange = session.canvasStatusChanged;
  const followPresentedWhiteboard = React.useCallback(
    (surface: MeetingSurfaceState) => session.presented(surface),
    [session],
  );
  const dismissWhiteboard = React.useCallback(() => session.dismiss(), [session]);
  const showWhiteboard = whiteboardState.locallyVisible;
  const handleMeasuredWhiteboardStatusChange = React.useCallback(
    (status: "loading" | "ready" | "fatal") => {
      handleWhiteboardStatusChange(status);
      if (status === "ready") {
        markMeetingEntryMetric("whiteboardReadyAt", { code });
      }
    },
    [code, handleWhiteboardStatusChange],
  );

  const handleWhiteboardCrash = React.useCallback(
    (_error: Error) => {
      handleWhiteboardStatusChange("fatal");
    },
    [handleWhiteboardStatusChange],
  );

  const handleApproveWhiteboard = React.useCallback(
    async (principalKey: string) => {
      try {
        // The request came from the board this moderator is looking at.
        if (!whiteboardDocumentId) throw new Error("No whiteboard is open");
        await grantWhiteboardEditAccess({
          data: {
            meetingId: joinResult.meetingId,
            whiteboardId: whiteboardDocumentId,
            targetPrincipalKey: principalKey,
            connectionId: joinResult.connectionId,
          },
        });
        setWhiteboardRequests((prev) =>
          prev.filter((request) => request.principalKey !== principalKey),
        );
        whiteboardRef.current?.clearPendingRequest(principalKey);
      } catch (err) {
        logError("[Meeting] Failed to grant whiteboard edit access:", err);
        addToast({
          title: "Approval failed",
          description: "Could not approve whiteboard access. Please try again.",
          data: { variant: "error" },
        });
      }
    },
    [addToast, joinResult.meetingId, joinResult.connectionId, whiteboardDocumentId],
  );

  const handleDenyWhiteboard = React.useCallback(
    async (principalKey: string) => {
      try {
        // The request came from the board this moderator is looking at.
        if (!whiteboardDocumentId) throw new Error("No whiteboard is open");
        await denyWhiteboardEditAccess({
          data: {
            meetingId: joinResult.meetingId,
            whiteboardId: whiteboardDocumentId,
            targetPrincipalKey: principalKey,
            connectionId: joinResult.connectionId,
          },
        });
        setWhiteboardRequests((prev) =>
          prev.filter((request) => request.principalKey !== principalKey),
        );
        whiteboardRef.current?.clearPendingRequest(principalKey);
      } catch (err) {
        logError("[Meeting] Failed to deny whiteboard edit access:", err);
        addToast({
          title: "Action failed",
          description: "Could not deny whiteboard access. Please try again.",
          data: { variant: "error" },
        });
      }
    },
    [addToast, joinResult.meetingId, joinResult.connectionId, whiteboardDocumentId],
  );

  React.useEffect(() => {
    if (!showWhiteboard) {
      setWhiteboardRequests([]);
    }
  }, [showWhiteboard]);

  // The presenter's "bring everyone to my page": their page becomes the
  // room's navigation at once. It fails only for someone not presenting.
  const handleSyncWhiteboard = React.useCallback(() => {
    if (whiteboardRef.current?.presentCurrentPage()) return;
    addToast({
      title: "Sync failed",
      description: "Only the presenter can bring everyone to their page.",
      data: { variant: "error" },
    });
  }, [addToast]);

  const whiteboardRequested = showWhiteboard;
  // Every upload, delete, and asset URL is scoped by this id, so there is no
  // useful fallback: a synthesized one would only produce authorization
  // failures that look like the document's own. Treat it like the token and
  // the URL — mount only once the real value has arrived.
  const resolvedWhiteboardId =
    whiteboardDocumentId ?? joinResult.surface?.documentId ?? null;
  const whiteboardCanMount =
    showWhiteboard &&
    whiteboardState.accessReady &&
    !!whiteboardToken &&
    !!whiteboardWsUrl &&
    !!resolvedWhiteboardId;
  const whiteboardReady =
    whiteboardRequested && whiteboardState.view === "ready";
  const whiteboardLoading =
    whiteboardRequested && whiteboardState.view === "loading";
  const whiteboardReconnecting =
    whiteboardRequested && whiteboardState.view === "reconnecting";
  const whiteboardError =
    whiteboardRequested && whiteboardState.view === "fatal";
  const whiteboardDisabledByConfig =
    whiteboardRequested && !whiteboardCanAttemptOpen;

  const reportViewFailure = React.useCallback(
    (error: unknown) => {
      logError("[Meeting] Failed to change Whiteboard visibility", error);
      addToast({
        title: "Whiteboard action failed",
        description: "Could not change the Whiteboard visibility. Please try again.",
        data: { variant: "error" },
      });
    },
    [addToast],
  );
  // Anyone can press Board. A moderator opens a closed board for everyone;
  // anyone else asks a moderator to, and pressing again takes the ask back.
  const boardRequests = useBoardRequests({
    room: meeting.roomInstance,
    meetingId: joinResult.meetingId,
    connectionId: joinResult.connectionId,
    canModerate: meeting.canModerate,
    boardOpen: whiteboardState.sharedSurfaceOpen,
    onDeclined: () =>
      addToast({
        title: "The board stays closed for now",
        description: "The host chose not to open it. You can ask again.",
      }),
  });
  const { asked: boardAsked, ask: askForBoard, takeBack: takeBackBoardAsk } = boardRequests;
  const mustAskForBoard = !whiteboardState.sharedSurfaceOpen && !meeting.canModerate;
  const showBoard = React.useCallback(() => {
    if (mustAskForBoard) {
      void (boardAsked ? takeBackBoardAsk() : askForBoard()).catch(() =>
        addToast({
          title: "Couldn't reach the host",
          description: "Try asking again in a moment.",
          data: { variant: "error" },
        }),
      );
      return;
    }
    void session.showBoard().catch(reportViewFailure);
  }, [addToast, askForBoard, boardAsked, mustAskForBoard, reportViewFailure, session, takeBackBoardAsk]);

  const approveBoardRequest = React.useCallback(() => {
    void session.showBoard().catch(reportViewFailure);
  }, [reportViewFailure, session]);
  const declineBoardRequest = React.useCallback(
    (admissionId: string) => {
      void boardRequests.decline(admissionId).catch((error: unknown) => {
        logError("[Meeting] Failed to decline the board request:", error);
        addToast({
          title: "Action failed",
          description: "Could not answer the request. Please try again.",
          data: { variant: "error" },
        });
      });
    },
    [addToast, boardRequests],
  );
  const showTalk = React.useCallback(() => session.showTalk(), [session]);
  const closeForEveryone = React.useCallback(() => {
    void session.hideOrClose().catch(reportViewFailure);
  }, [reportViewFailure, session]);

  const extensions: MeetingExtensions = {
    surface: {
      toolbarHeightPx: WHITEBOARD_TOOLBAR_HEIGHT.regular,
      show: whiteboardRequested,
      canMount: whiteboardCanMount,
      loading: whiteboardLoading,
      reconnecting: whiteboardReconnecting,
      error: whiteboardError,
      disabledByConfig: whiteboardDisabledByConfig,
      disabledReason: whiteboardDisabledReason,
      onClose: dismissWhiteboard,
      content: (
        <React.Suspense
          fallback={
            <div
              {...stylex.props(wbStyles.loading)}
            >
              <div {...stylex.props(wbStyles.centered)}>
                <div
                  {...stylex.props(wbStyles.tile)}
                >
                  <div {...stylex.props(spinner.ring, spinner.brand, spinner.lg)} />
                </div>
                <p {...stylex.props(wbStyles.caption)}>
                  Opening whiteboard…
                </p>
              </div>
            </div>
          }
        >
          {/* Keep the actual tldraw surface mounted and visible whenever it
              exists. The whiteboard component owns its loading/error states. */}
          <div
            {...stylex.props(wbStyles.surface)}
          >
            <WhiteboardSurfaceErrorBoundary
              key={`${joinResult.meetingId}:${joinResult.connectionId ?? ""}:${whiteboardDocumentId ?? ""}`}
              onError={handleWhiteboardCrash}
            >
              <LazyMeetingWhiteboard
                key={resolvedWhiteboardId ?? joinResult.meetingId}
                ref={whiteboardRef}
                whiteboardUrl={whiteboardWsUrl!}
                token={whiteboardToken!}
                getWebSocketUri={session.webSocketUri}
                meetingId={joinResult.meetingId}
                whiteboardId={resolvedWhiteboardId!}
                connectionId={joinResult.connectionId}
                onStatusChange={handleMeasuredWhiteboardStatusChange}
                onConnectionStatusChange={session.canvasConnectionChanged}
                aiEnabled
                assistantHost={orbHost}
                onPendingEditorRequestsChange={setWhiteboardRequests}
                onFollowStateChange={setWhiteboardFollow}
                isAuthenticated={isAuthenticated}
              />
            </WhiteboardSurfaceErrorBoundary>
          </div>
        </React.Suspense>
      ),
    },
    orb: { assistant: orbAssistant, history: orbHistory },
    surfaceToolbar: {
      // The kind, not the document. The dock's label slot is ~6rem wide, so a
      // real board title ("Whiteboard · 2026-08-20 standup") arrived as
      // "Whiteboard · 2…" — a control labelled with an ellipsis. The title is
      // carried separately and shown where there is room for it. "Board", as
      // the mode switch names it on every device.
      label: "Board",
      documentTitle:
        whiteboardDocumentTitle ?? joinResult.surface?.documentTitle ?? null,
      toggleLabel: showWhiteboard
        ? "Back to faces"
        : whiteboardState.sharedSurfaceOpen
          ? "Show the board"
          : !mustAskForBoard
            ? "Open the board for everyone"
            : boardAsked
              ? "Asked the host to open the board. Press to take it back"
              : "Ask the host to open the board",
      asked: boardAsked,
      active: showWhiteboard,
      onToggle: showWhiteboard ? showTalk : showBoard,
      onShowBoard: showBoard,
      onShowTalk: showTalk,
      onCloseForEveryone:
        meeting.canModerate && whiteboardState.sharedSurfaceOpen ? closeForEveryone : undefined,
      onChooseExisting:
        isAuthenticated &&
        meeting.canModerate &&
        (!whiteboardState.whiteboardId || whiteboardReady)
          ? () => setShowWhiteboardPicker(true)
          : undefined,
      chooseExistingLabel: "Open a Whiteboard",
      onSync: handleSyncWhiteboard,
      follow:
        showWhiteboard && whiteboardFollow
          ? {
              presenterName: whiteboardFollow.presenterName,
              following: whiteboardFollow.following,
              onFollow: whiteboardFollow.follow,
              onStopFollowing: whiteboardFollow.stopFollowing,
            }
          : undefined,
      disabled: isWhiteboardToggleDisabled({ canAttemptOpen: whiteboardCanAttemptOpen }),
      disabledReason: whiteboardDisabledReason,
    },
    extraPermissions: [
      ...boardRequests.requests.map((request) => ({
        kind: "extension" as const,
        id: `${BOARD_REQUEST_PREFIX}${request.admissionId}`,
        userId: request.identity,
        userName: request.userName,
        actionLabel: "opening the board",
        description: "Wants to open the whiteboard",
      })),
      ...whiteboardRequests.map((request) => ({
      kind: "extension" as const,
      id: `${EDIT_REQUEST_PREFIX}${request.principalKey}`,
      userId: request.principalKey,
      userName: request.userName,
      // The principal key already says which door they came through.
      guest: request.principalKey.startsWith("guest_admission:"),
      actionLabel: "whiteboard access",
      description: "Wants to draw on the whiteboard",
      })),
    ],
    // Opening the board answers every ask at once; drawing access is per person.
    onApproveExtraPermission: (requestId) => {
      if (requestId.startsWith(BOARD_REQUEST_PREFIX)) approveBoardRequest();
      else if (requestId.startsWith(EDIT_REQUEST_PREFIX)) void handleApproveWhiteboard(requestId.slice(EDIT_REQUEST_PREFIX.length));
    },
    onDenyExtraPermission: (requestId) => {
      if (requestId.startsWith(BOARD_REQUEST_PREFIX)) declineBoardRequest(requestId.slice(BOARD_REQUEST_PREFIX.length));
      else if (requestId.startsWith(EDIT_REQUEST_PREFIX)) void handleDenyWhiteboard(requestId.slice(EDIT_REQUEST_PREFIX.length));
    },
    overlay: (
      <React.Suspense fallback={null}>
        <LazyMeetingWhiteboardPicker
          meetingId={joinResult.meetingId}
          open={showWhiteboardPicker}
          onOpenChange={setShowWhiteboardPicker}
          onSelected={followPresentedWhiteboard}
          currentWhiteboardId={whiteboardState.whiteboardId}
        />
      </React.Suspense>
    ),
  };

  return { extensions, whiteboardOpen: whiteboardState.locallyVisible };
}

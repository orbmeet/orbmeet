import * as React from "react";
import { progress } from "@orbmeet/ui/styles/animations";
import { layout } from "@orbmeet/ui/styles/atoms";
import { surfaces } from "@orbmeet/ui/styles/surfaces";
import { inStage } from "@orbmeet/ui/styles/stage";
import { accent, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { useDelayedFlag } from "@/lib/hooks/use-delayed-flag";
import type { MeetingClockSync } from "@/modules/meetings/client/meeting-clock";
import { SIDE_PANEL_WIDTH } from "@/modules/meetings/client/meeting-styles";
import { selectRoomLayout } from "@/modules/meetings/client/room-layout";
import { selectComposition } from "@/modules/meetings/client/select-composition";
import type { ParticipantConnection } from "@/modules/meetings/client/use-livekit-connections";
import type { MeetingSidePanel } from "@/modules/meetings/client/use-meeting-ui";
import { MeetingShell } from "./meeting-shell";
import { MeetingTopBar } from "./meeting-top-bar";
import { ESSENTIAL_MEETING_UI, SECONDARY_MEETING_UI } from "./meeting-ui-modules";
import { SurfaceUnavailableOverlay } from "./surface-unavailable-overlay";

const styles = stylex.create({
  room: { backgroundColor: surface.canvas },
  fillBox: { width: "100%", height: "100%" },
  connectingOverlay: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: zIndex.modal,
    backgroundColor: `color-mix(in oklab, ${surface.canvas} 95%, transparent)`,
  },
  connectingCard: {
    borderRadius: radii.panel,
    paddingInline: space.s12,
    paddingBlock: space.s9,
    textAlign: "center",
  },
  spinner: {
    width: 36,
    height: 36,
    marginInline: "auto",
    marginBottom: space.s4,
    borderWidth: 2.5,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${accent.a500} 20%, transparent)`,
    borderTopColor: `color-mix(in oklab, ${accent.a700} 80%, transparent)`,
    borderRadius: radii.pill,
  },
  connectingLabel: { margin: 0, fontWeight: weight.medium, color: neutral.n600 },
  surfaceBackdrop: {
    backgroundColor: surface.board,
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: { default: "500ms", [env.reducedMotion]: "0s" },
    transitionTimingFunction: "ease-out",
  },
  shown: { opacity: 1 },
  stage: { position: "absolute", overflow: "hidden" },
  participantLayout: { display: "flex" },
  participantColumn: { flexDirection: "column" },
  contentRow: { display: "flex", minHeight: 0, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
  /** Talk's stage over a docked panel: what the panel leaves. */
  talkStage: { position: "relative", minHeight: 0, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
  /** The folded Conversation over Talk's stage: centred, above its bottom edge. */
  stageCaption: {
    position: "absolute",
    insetInline: 0,
    bottom: space.s5,
    zIndex: zIndex.meetingPanel,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
  },
  /** On the board: centred under its top band (`WHITEBOARD_CONTROLS_BAND_PX`). */
  boardCaption: {
    position: "absolute",
    top: 60,
    insetInline: 0,
    zIndex: zIndex.meetingPanel,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
  },
  /**
   * Under an upright board: the faces across, then on a phone the
   * Conversation's newest line, both in the height the short page leaves.
   */
  contentFoot: { display: "flex", flexShrink: 0, flexDirection: "column", gap: space.s2 },
  /** A phone's board runs edge to edge; its foot keeps off the edges and the dock. */
  contentFootPhone: { padding: space.s2 },
  /** A tablet's board is a card; its foot lines up with the card's edges. */
  contentFootCard: { paddingInline: space.s3, paddingBottom: space.s3 },
  surfaceCell: {
    position: "relative",
    minWidth: 0,
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    overflow: "hidden",
    backgroundColor: surface.board,
  },
  /**
   * Off a phone the content is a card on the room's ground, inset by the
   * room's gutter (`space.s4`) like the side panel beside it, rather than a desk running
   * to the window's edges. A phone keeps every pixel.
   */
  surfaceCard: {
    marginTop: space.s3,
    marginInline: space.s3,
    marginBottom: space.s3,
    borderRadius: radii.card,
    boxShadow: shadows.card,
  },
  surfaceContent: {
    overflow: "hidden",
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: { default: "500ms", [env.reducedMotion]: "0s" },
    transitionTimingFunction: "ease-out",
  },
  inert: { pointerEvents: "none" },
});

const LazyMeetingIdentity = React.lazy(() =>
  ESSENTIAL_MEETING_UI.identity().then((m) => ({ default: m.MeetingIdentity })),
);
const LazyVideoGrid = React.lazy(() =>
  ESSENTIAL_MEETING_UI.videoLayout().then((m) => ({ default: m.VideoGrid })),
);
const LazySpeakerStage = React.lazy(() =>
  ESSENTIAL_MEETING_UI.videoLayout().then((m) => ({ default: m.SpeakerStage })),
);
const LazyScreenShareStage = React.lazy(() =>
  ESSENTIAL_MEETING_UI.videoLayout().then((m) => ({ default: m.ScreenShareStage })),
);
const LazyRoomFaces = React.lazy(() =>
  ESSENTIAL_MEETING_UI.videoLayout().then((m) => ({ default: m.RoomFaces })),
);
const LazySideColumn = React.lazy(() =>
  SECONDARY_MEETING_UI.sideColumn().then((m) => ({ default: m.MeetingSideColumn })),
);

const NOOP = () => {};
const EMPTY_HANDS: readonly { userId: string; userName: string }[] = [];

export interface MeetingStageSurface {
  content: React.ReactNode;
  show: boolean;
  canMount: boolean;
  loading?: boolean;
  reconnecting?: boolean;
  error?: boolean;
  disabledByConfig?: boolean;
  disabledReason?: string | null;
  onClose?: () => void;
}

export interface MeetingStageLayoutProps {
  /** Callback ref scoping media elements inside the meeting shell. */
  mediaScope?: (element: HTMLDivElement | null) => void;
  code: string;
  meetingClock: MeetingClockSync;
  meetingTitle?: string | null;
  spaceName?: string | null;
  isRecording: boolean;
  isStreaming?: boolean;
  isScreenSharing?: boolean;
  /** Egress/recorder renders: stage + identity only, no interactive chrome. */
  readOnly?: boolean;
  /** Viewport geometry. */
  isPhone: boolean;
  isLandscape: boolean;
  isNarrow: boolean;
  useBottomSheet: boolean;
  /** Participants & connection state. */
  connectedParticipants: ParticipantConnection[];
  currentIdentity: string;
  isConnecting: boolean;
  isReconnecting: boolean;
  connectionOverlayLabel?: string;
  /** Stage content & surface. */
  showScreenShareStage: boolean;
  onStopPresenting?: () => void;
  surface?: MeetingStageSurface;
  surfaceLabel?: string;
  /** Interactive chrome slots (omitted by readOnly recorder). */
  header?: React.ReactNode;
  dock?: React.ReactNode;
  dockVisible?: boolean;
  hasModeSwitch?: boolean;
  rail?: React.ReactNode;
  panelWidth?: string;
  openPanel?: MeetingSidePanel | null;
  renderBelowPanel?: () => React.ReactNode;
  renderSideColumn?: (facesColumn: React.ReactNode, sideColumnShown: boolean) => React.ReactNode;
  boardCaption?: React.ReactNode;
  stageCaption?: React.ReactNode;
  phoneContentFootExtra?: React.ReactNode;
  raisedHands?: readonly { userId: string; userName: string }[];
  onShowEveryone?: () => void;
  onCallOn?: (userId: string) => void;
  /** Video tile controls. */
  videoDevices?: MediaDeviceInfo[];
  currentVideoDeviceId?: string;
  onSelectVideoDevice?: (deviceId: string | undefined) => void;
  onRefreshVideoDevices?: () => void;
  renderTileActions?: (identity: string) => React.ReactNode;
  /** Extra overlays/dialogs/banners rendered inside MeetingShell. */
  children?: React.ReactNode;
}

/**
 * The shared meeting stage shell: video grid / speaker spotlight, shared screen
 * or board surface, responsive face rail/column, top identity bar, and
 * connection overlay. Used directly by the headless recorder (`readOnly`), and
 * wrapped by `LiveMeetingLayout` with interactive room controls and panels.
 */
/* oxlint-disable react/refs -- mediaScope is a callback ref passed through to MeetingShell. */
export function MeetingStageLayout({
  mediaScope,
  code,
  meetingClock,
  meetingTitle = null,
  spaceName = null,
  isRecording,
  isStreaming = false,
  isScreenSharing = false,
  readOnly = false,
  isPhone,
  isLandscape,
  isNarrow,
  useBottomSheet,
  connectedParticipants,
  currentIdentity,
  isConnecting,
  isReconnecting,
  connectionOverlayLabel = "Joining meeting...",
  showScreenShareStage,
  onStopPresenting,
  surface: stageSurface,
  surfaceLabel = "Whiteboard",
  header,
  dock,
  dockVisible,
  hasModeSwitch = false,
  rail,
  panelWidth,
  openPanel = null,
  renderBelowPanel,
  renderSideColumn,
  boardCaption,
  stageCaption,
  phoneContentFootExtra,
  raisedHands = EMPTY_HANDS,
  onShowEveryone = NOOP,
  onCallOn,
  videoDevices = [],
  currentVideoDeviceId,
  onSelectVideoDevice,
  onRefreshVideoDevices,
  renderTileActions,
  children,
}: MeetingStageLayoutProps) {
  // Only a reconnect that lasts is worth an overlay; a blip shows nothing.
  const showReconnecting = useDelayedFlag(isReconnecting, 1500);

  const surfaceRequested = stageSurface?.show ?? false;
  const surfaceLoading = stageSurface?.loading ?? false;
  const surfaceReconnecting = stageSurface?.reconnecting ?? false;
  const surfaceError = stageSurface?.error ?? false;
  const surfaceDisabledByConfig = stageSurface?.disabledByConfig ?? false;
  const surfaceReady =
    surfaceRequested &&
    !surfaceLoading &&
    !surfaceReconnecting &&
    !surfaceError &&
    !surfaceDisabledByConfig;
  const showSurfaceContent = surfaceReady && !showScreenShareStage;
  const hasContent = surfaceRequested || showScreenShareStage;
  const showSurfaceStage = showSurfaceContent || showScreenShareStage;

  const composition = selectComposition({
    participantCount: connectedParticipants.length,
    hasContent,
    isPhone,
    isLandscape,
  });
  const railOrientation = isNarrow && !isLandscape ? "horizontal" : "vertical";
  const roomLayout = selectRoomLayout({
    usesBottomSheets: useBottomSheet,
    isPhone,
    isLandscape,
    contentOnStage: hasContent,
    panel: openPanel,
  });

  // Nobody else here, nobody to show: the board keeps the width.
  const facesInColumn =
    roomLayout.faces === "column" &&
    connectedParticipants.some((person) => person.identity !== currentIdentity);
  const sideColumnShown = roomLayout.placement === "side" || facesInColumn;
  const defaultPanelWidth = sideColumnShown ? `calc(${SIDE_PANEL_WIDTH} + ${space.s3})` : "0px";

  const facesColumn = facesInColumn && (
    <React.Suspense fallback={null}>
      <LazyRoomFaces
        variant="column"
        roomy={roomLayout.active === null}
        readOnly={readOnly}
        raisedHands={raisedHands}
        onShowEveryone={onShowEveryone}
        onCallOn={onCallOn}
      />
    </React.Suspense>
  );

  const mainVideoArea = (
    <React.Suspense fallback={<div {...stylex.props(styles.fillBox)} />}>
      {composition === "spotlight" ? (
        <LazySpeakerStage
          connections={connectedParticipants}
          excludeLocalParticipant={readOnly}
          railOrientation={railOrientation}
          videoDevices={videoDevices}
          currentVideoDeviceId={currentVideoDeviceId}
          onSelectVideoDevice={onSelectVideoDevice}
          onRefreshVideoDevices={onRefreshVideoDevices}
        />
      ) : (
        <LazyVideoGrid
          connections={connectedParticipants}
          excludeLocalParticipant={readOnly}
          videoDevices={videoDevices}
          currentVideoDeviceId={currentVideoDeviceId}
          onSelectVideoDevice={onSelectVideoDevice}
          onRefreshVideoDevices={onRefreshVideoDevices}
          renderTileActions={renderTileActions}
          meetingCode={code}
        />
      )}
    </React.Suspense>
  );

  const defaultReadOnlyHeader = !isPhone ? (
    <MeetingTopBar
      identity={
        <React.Suspense fallback={null}>
          <LazyMeetingIdentity
            code={code}
            meetingTitle={meetingTitle}
            spaceName={spaceName}
            meetingClock={meetingClock}
            isRecording={isRecording}
            isStreaming={isStreaming}
            isScreenSharing={isScreenSharing}
            surfaceActive={surfaceRequested}
            surfaceLabel={surfaceLabel}
            readOnly
            peopleCount={connectedParticipants.length}
          />
        </React.Suspense>
      }
    />
  ) : undefined;

  const defaultSideColumn =
    !useBottomSheet && sideColumnShown && facesColumn ? (
      <React.Suspense fallback={null}>
        <LazySideColumn
          width={SIDE_PANEL_WIDTH}
          placement="side"
          tabs={[]}
          active={null}
          onClose={NOOP}
          top={facesColumn}
        >
          {null}
        </LazySideColumn>
      </React.Suspense>
    ) : null;

  return (
    <MeetingShell
      ref={mediaScope}
      isPhone={isPhone}
      sx={styles.room}
      header={header !== undefined ? header : defaultReadOnlyHeader}
      dock={dock}
      dockVisible={dockVisible ?? !isPhone}
      hasModeSwitch={hasModeSwitch}
      rail={rail}
      panelWidth={panelWidth ?? defaultPanelWidth}
    >
      {(isConnecting || showReconnecting) && (
        <div
          // No backdrop-filter: at 95% opacity nothing behind this is visible,
          // so the blur was a viewport-sized filter pass over live video that
          // rendered no pixels anyone could see.
          {...stylex.props(layout.fill, styles.connectingOverlay)}
        >
          <div {...stylex.props(surfaces.glassSolid, styles.connectingCard)}>
            <div {...stylex.props(progress.spin, styles.spinner)} />
            <p {...stylex.props(styles.connectingLabel)}>{connectionOverlayLabel}</p>
          </div>
        </div>
      )}

      {/* A phone's surface backdrop bleeds to the display edge so the floating
          dock sits on one continuous canvas; off a phone the surface is a card. */}
      <div
        aria-hidden="true"
        {...stylex.props(
          layout.decorative,
          layout.fill,
          styles.surfaceBackdrop,
          showSurfaceStage && isPhone && styles.shown,
        )}
      />

      <div {...stylex.props(styles.stage, hasContent ? inStage.fill : inStage.fillBesidePanel)}>
        {hasContent ? (
          <>
            <div {...stylex.props(layout.fill, styles.participantLayout, styles.participantColumn)}>
              <div {...stylex.props(styles.contentRow)}>
                <div {...stylex.props(styles.surfaceCell, !isPhone && styles.surfaceCard)}>
                  <div
                    {...stylex.props(
                      layout.fill,
                      styles.surfaceContent,
                      showSurfaceStage ? styles.shown : styles.inert,
                    )}
                  >
                    {showScreenShareStage ? (
                      <React.Suspense fallback={<div {...stylex.props(styles.fillBox)} />}>
                        <LazyScreenShareStage onStopPresenting={onStopPresenting} />
                      </React.Suspense>
                    ) : stageSurface?.canMount ? (
                      stageSurface.content
                    ) : null}
                    {boardCaption && <div {...stylex.props(styles.boardCaption)}>{boardCaption}</div>}
                  </div>
                </div>
              </div>

              {roomLayout.faces === "row" && (
                <div
                  {...stylex.props(
                    styles.contentFoot,
                    isPhone ? styles.contentFootPhone : styles.contentFootCard,
                  )}
                >
                  <React.Suspense fallback={null}>
                    <LazyRoomFaces
                      variant="row"
                      roomy={!isPhone}
                      readOnly={readOnly}
                      raisedHands={raisedHands}
                      onShowEveryone={onShowEveryone}
                    />
                    {phoneContentFootExtra}
                  </React.Suspense>
                </div>
              )}

              {roomLayout.placement === "below" && renderBelowPanel?.()}
            </div>

            {surfaceRequested &&
              !showScreenShareStage &&
              (surfaceLoading || surfaceReconnecting || surfaceError || surfaceDisabledByConfig) && (
                <SurfaceUnavailableOverlay
                  disabledByConfig={surfaceDisabledByConfig}
                  disabledReason={stageSurface?.disabledReason}
                  reconnecting={surfaceReconnecting}
                  error={surfaceError}
                  onClose={stageSurface?.onClose}
                />
              )}
          </>
        ) : roomLayout.placement === "below" ? (
          <div {...stylex.props(layout.fill, styles.participantLayout, styles.participantColumn)}>
            <div {...stylex.props(styles.talkStage)}>{mainVideoArea}</div>
            {renderBelowPanel?.()}
          </div>
        ) : (
          <>
            {mainVideoArea}
            {stageCaption && <div {...stylex.props(styles.stageCaption)}>{stageCaption}</div>}
          </>
        )}
      </div>

      {children}

      {renderSideColumn ? renderSideColumn(facesColumn, sideColumnShown) : defaultSideColumn}
    </MeetingShell>
  );
}
/* oxlint-enable react/refs */

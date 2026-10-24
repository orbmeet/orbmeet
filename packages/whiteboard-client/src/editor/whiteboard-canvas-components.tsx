import { createContext, useContext, type ComponentProps } from "react";
import * as stylex from "@stylexjs/stylex";
import { danger, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { WHITEBOARD_PHONE_PORTRAIT_INSETS } from "../camera/viewport-insets";
import { PageShadows } from "../pages/page-shadows";
import { ShowSourcesOverlay } from "../sources/show-sources-overlay";
import { WhiteboardToolbar } from "../toolbar/whiteboard-toolbar";
import { WhiteboardCanvasOverlays } from "../toolbar/whiteboard-toolbar-overlays";
import { WhiteboardInputRecovery, WhiteboardPenModeBridge } from "./whiteboard-editor-internals";

// What the board puts inside tldraw's own tree: the overlays in front of the
// canvas, the page shadows on it, and the crash ground. tldraw renders these as
// component types it holds by identity, so they read the board's live state
// from `WhiteboardCanvasSlotsContext` rather than from props.

export interface WhiteboardCanvasSlotsValue {
  canEdit: boolean;
  /** A compact board with no tool band: its top edge is painted over, see `WhiteboardReaderEdge`. */
  readerEdge: boolean;
  pageShadows: ComponentProps<typeof PageShadows>;
}

export const WhiteboardCanvasSlotsContext = createContext<WhiteboardCanvasSlotsValue | null>(null);

function useWhiteboardCanvasSlots(): WhiteboardCanvasSlotsValue {
  const value = useContext(WhiteboardCanvasSlotsContext);
  if (!value) {
    throw new Error("Whiteboard canvas slots must be rendered inside their provider.");
  }
  return value;
}

function WhiteboardInFrontOfCanvas() {
  const { canEdit, readerEdge } = useWhiteboardCanvasSlots();
  return (
    <>
      <WhiteboardInputRecovery />
      <WhiteboardPenModeBridge />
      <ShowSourcesOverlay />
      {canEdit && <WhiteboardToolbar />}
      {readerEdge && <WhiteboardReaderEdge />}
      {canEdit && <WhiteboardCanvasOverlays />}
    </>
  );
}

/**
 * The top edge of a compact board with no tool band, painted the desk.
 *
 * A phone shows each page from its top, a few pixels under the board's edge,
 * and the page before it ends just 40 page units higher: at a phone's zoom
 * that gap is narrower than the edge, so a sliver of the previous page sat
 * over the current one and read as a glitch. The edge is no deeper than the
 * camera's own top inset, so it never covers the page it is showing.
 */
function WhiteboardReaderEdge() {
  return <div aria-hidden="true" {...stylex.props(styles.readerEdge(WHITEBOARD_PHONE_PORTRAIT_INSETS.top))} />;
}

function WhiteboardOnCanvas() {
  const { pageShadows } = useWhiteboardCanvasSlots();
  return <PageShadows {...pageShadows} />;
}

const styles = stylex.create({
  /** Dynamic: StyleX cannot read the imported inset at build time, and a copy of it would drift. */
  readerEdge: (height: number) => ({
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: boardZIndex.chrome,
    height,
    backgroundColor: `var(--wb-document-bg, ${surface.board})`,
    pointerEvents: "none",
  }),
  /** The crash and connection-failure grounds. */
  fallback: {
    display: "flex",
    height: "100%",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.s6,
    color: neutral.n800,
    // The desk, so a board that fails to load still reads as a board.
    backgroundColor: surface.board,
  },
  fallbackTerse: {
    width: "auto",
    paddingInline: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: danger.d600,
  },
  crashCard: {
    maxWidth: "24rem",
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: danger.d200,
    backgroundColor: danger.d50,
    paddingInline: space.s5,
    paddingBlock: space.s4,
    fontSize: text.sm,
    lineHeight: leading.sm,
    boxShadow: shadows.lift1,
  },
  crashTitle: { fontWeight: weight.semibold, color: danger.d800 },
  crashBody: { marginTop: space.s2, marginBottom: 0, color: danger.d900 },
  crashDetail: {
    marginTop: space.s3,
    marginBottom: 0,
    overflowWrap: "break-word",
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: danger.d700,
  },
});

/** The ground a board that could not connect shows instead of itself. */
export function WhiteboardConnectFailure({ message }: { message: string }) {
  return <div {...stylex.props(styles.fallback, styles.fallbackTerse)}>{message}</div>;
}

function WhiteboardErrorFallback({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "The whiteboard editor crashed.";
  return (
    <div {...stylex.props(styles.fallback)}>
      <div {...stylex.props(styles.crashCard)}>
        <div {...stylex.props(styles.crashTitle)}>Whiteboard needs a refresh</div>
        <p {...stylex.props(styles.crashBody)}>
          The editor hit an internal error. Reopen the board or rejoin the meeting to reload it.
        </p>
        <p {...stylex.props(styles.crashDetail)}>{message}</p>
      </div>
    </div>
  );
}

// Tldraw treats these values as React component types. Keep both the object and
// every component it references static so ordinary whiteboard state changes do
// not unmount editor overlays and their subscriptions.
export const whiteboardComponents = {
  Toolbar: null,
  InFrontOfTheCanvas: WhiteboardInFrontOfCanvas,
  OnTheCanvas: WhiteboardOnCanvas,
  PageMenu: null,
  Minimap: null,
  NavigationPanel: null,
  StylePanel: null,
  MainMenu: null,
  ActionsMenu: null,
  QuickActions: null,
  HelpMenu: null,
  ZoomMenu: null,
  SharePanel: null,
  LoadingScreen: null,
  ErrorFallback: WhiteboardErrorFallback,
};

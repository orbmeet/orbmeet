import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, useValue } from "tldraw";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import type { PageNavigator } from "./page-navigator";
import {
  parsePageBackground,
  type PageBackground,
} from "@orbmeet/whiteboard-core/page-background";
import {
  getPageFrameBackground,
  getPageFrameHeight,
  getPageFrameName,
  getPageFrameWidth,
  isPageFrameShape,
} from "@orbmeet/whiteboard-core/page-frame-model";
import {
  getPullToAddProgress,
  AUTO_ADD_PAGE_PULL_DISTANCE_PX,
  PULL_TO_ADD_INDICATOR_MIN_PROGRESS,
  hasPulledPastPageTop,
  isPullToAddReady,
} from "./pull-to-add";
import { usePullToAddPage } from "./use-pull-to-add-page";
import { ArrowDown, FilePlus } from "lucide-react";
import { fonts, leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { accent, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { scrim } from "@orbmeet/ui/tokens/wash.stylex";
import * as stylex from "@stylexjs/stylex";

/**
 * The indicator floats in page space, inside tldraw's own stacking context, so
 * it is ordered against the other page-space overlays rather than against board
 * chrome — `boardZIndex` is the wrong scale for it.
 */
const PULL_INDICATOR_Z_INDEX = 10;

/** How far the arrow drifts down over a full pull, in page pixels. */
const ARROW_TRAVEL_PX = 5;

const styles = stylex.create({
  pullLabel: {
    whiteSpace: "nowrap",
    fontFamily: fonts.sans,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    letterSpacing: tracking.wide,
  },

  /**
   * Everything about the indicator that does not move with the camera. Only
   * placement, scale and opacity are gesture-derived; those stay dynamic
   * below, and nothing else needs to be an inline style.
   */
  indicator: {
    position: "absolute",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s3,
    pointerEvents: "none",
    zIndex: PULL_INDICATOR_Z_INDEX,
    transitionProperty: "color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  indicatorIdle: { color: neutral.n400 },
  indicatorReady: { color: accent.a500 },
  /** Placement and pull feedback: the only genuinely per-frame values. */
  indicatorAt: (top: number, left: number, progress: number) => ({
    top,
    left,
    transform: `translate(-50%, -50%) scale(${0.8 + progress * 0.2})`,
    opacity: Math.max(0.3, progress),
  }),

  disc: {
    display: "flex",
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    borderWidth: 3,
    borderStyle: "solid",
    backgroundColor: surface.raised,
    transitionProperty: "border-color, box-shadow",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  discIdle: {
    borderColor: neutral.n300,
    boxShadow: `0 2px 8px ${scrim.hairline}`,
  },
  discReady: {
    borderColor: accent.a500,
    boxShadow: `0 4px 12px color-mix(in oklab, ${accent.a500} 20%, transparent)`,
  },

  arrow: {
    transitionProperty: "transform",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.linear,
  },
  arrowNudge: (progress: number) => ({
    transform: `translateY(${progress * ARROW_TRAVEL_PX}px)`,
  }),
});

const { PAGE_WIDTH, PAGE_HEIGHT } = WHITEBOARD_CONFIG;

interface FrameRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  background: PageBackground;
  name: string;
}

interface ViewportState {
  top: number;
  bottom: number;
  zoom: number;
  nearFitZoom: boolean;
}

interface PageShadowsProps {
  canAddPages: boolean;
  isAddingPage?: boolean;
  onAddPage?: () => void;
  /**
   * The camera constraints are the single source of truth for "is the camera
   * near fit-width zoom": they own the padded fit-x math, and recomputing it
   * here from raw viewport width would drift from what the camera does. Its
   * suppression window also holds pull-to-add off a programmatic move.
   */
  navigator?: PageNavigator | null;
}

interface PullToAddPageIndicatorProps {
  top: number;
  left: number;
  progress: number;
  ready: boolean;
}

function areFramesEqual(a: FrameRect[], b: FrameRect[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.x !== right.x ||
      left.y !== right.y ||
      left.w !== right.w ||
      left.h !== right.h ||
      left.name !== right.name ||
      left.background !== right.background
    ) {
      return false;
    }
  }

  return true;
}

function areViewportStatesEqual(a: ViewportState, b: ViewportState): boolean {
  return (
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.bottom - b.bottom) < 0.5 &&
    a.zoom === b.zoom &&
    a.nearFitZoom === b.nearFitZoom
  );
}

function PullToAddPageIndicator({
  top,
  left,
  progress,
  ready,
}: PullToAddPageIndicatorProps) {
  return (
    <div
      {...stylex.props(
        styles.indicator,
        ready ? styles.indicatorReady : styles.indicatorIdle,
        styles.indicatorAt(top, left, progress),
      )}
    >
      <div {...stylex.props(styles.disc, ready ? styles.discReady : styles.discIdle)}>
        {ready ? (
          <FilePlus size={28} />
        ) : (
          <ArrowDown size={28} {...stylex.props(styles.arrow, styles.arrowNudge(progress))} />
        )}
      </div>
      <span {...stylex.props(styles.pullLabel)}>
        {ready ? "Release to add a page" : "Pull to add a page"}
      </span>
    </div>
  );
}

/**
 * Tracks page frames in page-space coordinates for overlays that need to align
 * with the document. The actual page paper is rendered by WhiteboardPageShapeUtil
 * so it shares the same layer and lifecycle as the frame-like page shape.
 */
/* oxlint-disable react/refs -- oxlint 1.85 still reports imperative editor/ref reads inside an explicitly opted-out component. */
export function PageShadows({
  canAddPages,
  isAddingPage = false,
  onAddPage,
  navigator,
}: PageShadowsProps) {
  "use no memo";
  // Pull suppression is an imperative timestamp shared with the camera gesture
  // controller; reading it during a viewport-driven render is intentional.
  const editor = useEditor();
  const [frames, setFrames] = useState<FrameRect[]>([]);
  const [viewportState, setViewportState] = useState<ViewportState>({
    top: 0,
    bottom: 0,
    zoom: 1,
    nearFitZoom: true,
  });
  const rafRef = useRef(0);
  const cameraRafRef = useRef(0);

  const updateFrames = useCallback(() => {
    const shapes = editor.getCurrentPageShapes();
    const pageFrames: FrameRect[] = [];

    for (const shape of shapes) {
      if (!isPageFrameShape(shape)) continue;

      pageFrames.push({
        id: shape.id,
        x: shape.x,
        y: shape.y,
        w: getPageFrameWidth(shape) ?? PAGE_WIDTH,
        h: getPageFrameHeight(shape) ?? PAGE_HEIGHT,
        background: parsePageBackground(getPageFrameBackground(shape)),
        name: getPageFrameName(shape) ?? "",
      });
    }

    pageFrames.sort((a, b) => a.y - b.y);
    setFrames((prev) => (areFramesEqual(prev, pageFrames) ? prev : pageFrames));
  }, [editor]);

  useEffect(() => {
    updateFrames();

    const updateCamera = () => {
      const cameraConstraints = navigator?.cameraConstraints;
      const viewportBounds =
        cameraConstraints?.getVisibleViewportBounds() ??
        editor.getViewportPageBounds();
      // Pull geometry is a coordinate conversion, so it needs the exact camera
      // zoom rather than tldraw's stepped rendering-performance approximation.
      const zoom = editor.getCamera().z;
      const nextState = {
        top: viewportBounds.y,
        bottom: viewportBounds.y + viewportBounds.h,
        zoom,
        nearFitZoom: cameraConstraints?.isNearFitXZoom() ?? true,
      };
      setViewportState((prev) =>
        areViewportStatesEqual(prev, nextState) ? prev : nextState
      );
    };
    updateCamera();

    const scheduleCameraUpdate = () => {
      cancelAnimationFrame(cameraRafRef.current);
      cameraRafRef.current = requestAnimationFrame(updateCamera);
    };

    const unsubStore = editor.store.listen(
      () => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(updateFrames);
      },
      { scope: "document" }
    );

    const unsubCamera = editor.store.listen(scheduleCameraUpdate, {
      scope: "session",
    });

    return () => {
      unsubStore();
      unsubCamera();
      cancelAnimationFrame(rafRef.current);
      cancelAnimationFrame(cameraRafRef.current);
    };
  }, [editor, navigator, updateFrames]);

  const lastFrame = frames.length > 0 ? frames[frames.length - 1] : null;

  let pullProgress = 0;
  let indicatorTop = 0;
  let pullReady = false;
  // While the board is being moved for the reader (a page turn, a new page,
  // the leader), the view passing the end of the document is not a pull.
  const pullSuppressed = useValue("whiteboard camera moving", () => navigator?.director.moving.get() ?? false, [navigator]);
  if (lastFrame) {
    const lastPageBottom = lastFrame.y + lastFrame.h;
    const zoom = Math.max(viewportState.zoom, 0.01);
    const minOffset = 24 / zoom;
    const trailingGap = 56 / zoom;
    const pullDistance = AUTO_ADD_PAGE_PULL_DISTANCE_PX / zoom;
    const isActuallyPulledPastPage =
      hasPulledPastPageTop(lastFrame.y, viewportState.top, minOffset);

    pullProgress = isActuallyPulledPastPage
      ? getPullToAddProgress(
          lastPageBottom,
          viewportState.bottom,
          pullDistance,
        )
      : 0;
    pullReady =
      !pullSuppressed &&
      isActuallyPulledPastPage &&
      isPullToAddReady(lastPageBottom, viewportState.bottom, pullDistance);
    indicatorTop = Math.min(
      lastPageBottom + pullDistance - minOffset,
      Math.max(
        lastPageBottom + minOffset,
        viewportState.bottom - trailingGap
      )
    );
  }

  usePullToAddPage({
    enabled:
      canAddPages &&
      !isAddingPage &&
      viewportState.nearFitZoom,
    ready: pullReady,
    onAddPage,
    container: editor.getContainer(),
    isSuppressed: navigator ? () => navigator.director.moving.get() : undefined,
  });

  return (
    <>
      {/* Pull to Add Page Indicator */}
      {canAddPages &&
        !isAddingPage &&
        !pullSuppressed &&
        lastFrame &&
        viewportState.nearFitZoom &&
        pullProgress >= PULL_TO_ADD_INDICATOR_MIN_PROGRESS && (
          <PullToAddPageIndicator
            top={indicatorTop}
            left={lastFrame.x + lastFrame.w / 2}
            progress={pullProgress}
            ready={pullReady}
          />
      )}
    </>
  );
}
/* oxlint-enable react/refs */

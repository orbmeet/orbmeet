/**
 * Responsive whiteboard configuration
 *
 * CANONICAL PAGE SIZE: All devices use the same fixed 16:9 page (1200×675).
 * Each device uses the same document geometry. Camera fitting is handled
 * separately from document dimensions so viewport changes never resize content.
 */

import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
const RESPONSIVE_BREAKPOINTS = {
  PHONE_MAX_WIDTH: 640,
  PHONE_LANDSCAPE_MAX_HEIGHT: 500,
  TABLET_MAX_WIDTH: 1024,
} as const;

function classifyViewport({ width, height }: { width: number; height: number }) {
  const isLandscape = width > height;
  const isPhone = width < RESPONSIVE_BREAKPOINTS.PHONE_MAX_WIDTH ||
    isLandscape && height < RESPONSIVE_BREAKPOINTS.PHONE_LANDSCAPE_MAX_HEIGHT;
  return {
    isLandscape,
    isPhone,
    isTablet: !isPhone && width < RESPONSIVE_BREAKPOINTS.TABLET_MAX_WIDTH,
  };
}

const { PAGE_WIDTH, PAGE_HEIGHT, PAGE_SPACING, CAMERA_PADDING } = WHITEBOARD_CONFIG;

const BREAKPOINTS = {
  MOBILE_PORTRAIT_MAX: RESPONSIVE_BREAKPOINTS.PHONE_MAX_WIDTH,
  MOBILE_LANDSCAPE_MAX:
    RESPONSIVE_BREAKPOINTS.PHONE_LANDSCAPE_MAX_HEIGHT,
  TABLET_MAX: RESPONSIVE_BREAKPOINTS.TABLET_MAX_WIDTH,
  DESKTOP_LANDSCAPE_MIN_WIDTH: 1280,
  DESKTOP_LANDSCAPE_MIN_HEIGHT: 720,
} as const;

export type ViewportCategory =
  | "mobile-portrait"
  | "mobile-landscape"
  | "tablet"
  | "desktop";

export interface ViewportInfo {
  width: number;
  height: number;
  category: ViewportCategory;
  isPortrait: boolean;
  aspectRatio: number;
}

export interface ResponsivePageInfo {
  width: number;
  height: number;
  aspectRatio: number;
  category: ViewportCategory;
}

export function getViewportCategory(viewport: { width: number; height: number }): ViewportCategory {
  const { width, height } = viewport;
  const classified = classifyViewport(viewport);
  if (classified.isPhone) {
    return classified.isLandscape ? "mobile-landscape" : "mobile-portrait";
  }
  if (
    classified.isLandscape &&
    width >= BREAKPOINTS.DESKTOP_LANDSCAPE_MIN_WIDTH &&
    height >= BREAKPOINTS.DESKTOP_LANDSCAPE_MIN_HEIGHT
  ) {
    return "desktop";
  }
  if (
    classified.isTablet ||
    (classified.isLandscape && Math.min(width, height) < BREAKPOINTS.TABLET_MAX)
  ) {
    return "tablet";
  }
  return "desktop";
}

function getViewportInfo(viewport: { width: number; height: number }): ViewportInfo {
  const { width, height } = viewport;
  return {
    width,
    height,
    category: getViewportCategory(viewport),
    isPortrait: height > width,
    aspectRatio: width / height,
  };
}

function calculatePageDimensions(viewport: { width: number; height: number }): ResponsivePageInfo {
  return {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    aspectRatio: PAGE_WIDTH / PAGE_HEIGHT,
    category: getViewportCategory(viewport),
  };
}

export function calculateCameraPadding(viewport: { width: number; height: number }): number {
  const category = getViewportCategory(viewport);
  switch (category) {
    case "mobile-portrait":
    case "mobile-landscape":
      return Math.max(16, Math.round(CAMERA_PADDING * 0.5));
    case "tablet":
      return Math.max(24, Math.round(CAMERA_PADDING * 0.75));
    default:
      return CAMERA_PADDING;
  }
}

export function getResponsiveConfig(viewport: { width: number; height: number }) {
  return {
    viewport: getViewportInfo(viewport),
    page: calculatePageDimensions(viewport),
    pageSpacing: PAGE_SPACING,
    cameraPadding: calculateCameraPadding(viewport),
  };
}

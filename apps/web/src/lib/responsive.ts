const RESPONSIVE_BREAKPOINTS = {
  PHONE_MAX_WIDTH: 640,
  PHONE_LANDSCAPE_MAX_HEIGHT: 500,
  TABLET_MAX_WIDTH: 1024,
} as const;

export type DeviceMode = "phone" | "tablet" | "desktop";
export type Orientation = "portrait" | "landscape";

export interface ViewportClassification {
  mode: DeviceMode;
  orientation: Orientation;
  isPhone: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isLandscape: boolean;
  isNarrow: boolean;
  useBottomSheet: boolean;
}

export function classifyViewport(viewport: {
  width: number;
  height: number;
}): ViewportClassification {
  const { width, height } = viewport;
  const isLandscape = width > height;
  const isPhone =
    width < RESPONSIVE_BREAKPOINTS.PHONE_MAX_WIDTH ||
    (isLandscape &&
      height < RESPONSIVE_BREAKPOINTS.PHONE_LANDSCAPE_MAX_HEIGHT);
  const isTablet =
    !isPhone && width < RESPONSIVE_BREAKPOINTS.TABLET_MAX_WIDTH;
  const isDesktop = !isPhone && !isTablet;
  const isNarrow = isPhone || (isTablet && !isLandscape);

  return {
    mode: isPhone ? "phone" : isTablet ? "tablet" : "desktop",
    orientation: isLandscape ? "landscape" : "portrait",
    isPhone,
    isTablet,
    isDesktop,
    isLandscape,
    isNarrow,
    useBottomSheet: isNarrow,
  };
}

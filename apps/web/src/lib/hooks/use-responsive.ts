import { useSyncExternalStore } from "react";
import {
  classifyViewport,
  type DeviceMode,
  type Orientation,
} from "@/lib/responsive";

export interface ResponsiveState {
  mode: DeviceMode;
  orientation: Orientation;
  isPhone: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isLandscape: boolean;
  /** True when narrow, phone-like meeting chrome should be used */
  isNarrow: boolean;
  /** True when compact meeting controls should be used */
  isCompact: boolean;
  /** True on phone landscape — controls should auto-hide */
  controlBarAutoHide: boolean;
  /** True when panels should render as bottom sheets */
  useBottomSheet: boolean;
}

function computeState(): ResponsiveState {
  if (typeof window === "undefined") return DESKTOP_DEFAULT;

  const classified = classifyViewport({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  return {
    ...classified,
    isCompact: classified.isNarrow,
    controlBarAutoHide: classified.isPhone && classified.isLandscape,
  };
}

const DESKTOP_DEFAULT: ResponsiveState = {
  mode: "desktop",
  orientation: "landscape",
  isPhone: false,
  isTablet: false,
  isDesktop: true,
  isLandscape: true,
  isNarrow: false,
  isCompact: false,
  controlBarAutoHide: false,
  useBottomSheet: false,
};

let cache: ResponsiveState | null = null;
const listeners = new Set<() => void>();

function sameState(a: ResponsiveState, b: ResponsiveState): boolean {
  return (Object.keys(a) as Array<keyof ResponsiveState>).every((key) => a[key] === b[key]);
}

// Every resize event fires this, but the state only changes at breakpoints.
// Keeping the cached object when nothing it holds changed is what lets
// useSyncExternalStore skip re-rendering every consumer while a window drags.
function notify() {
  const next = computeState();
  if (cache && sameState(cache, next)) return;
  cache = next;
  listeners.forEach((cb) => cb());
}

function subscribe(callback: () => void) {
  listeners.add(callback);

  // Set up listeners once (on first subscriber)
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("resize", notify);
    window.addEventListener("orientationchange", notify);
  }

  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("resize", notify);
      window.removeEventListener("orientationchange", notify);
    }
  };
}

function getSnapshot(): ResponsiveState {
  if (typeof window === "undefined") return DESKTOP_DEFAULT;
  if (!cache) cache = computeState();
  return cache;
}

function getServerSnapshot(): ResponsiveState {
  return DESKTOP_DEFAULT;
}

export function useResponsive(): ResponsiveState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

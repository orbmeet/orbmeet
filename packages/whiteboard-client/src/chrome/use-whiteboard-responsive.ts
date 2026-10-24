import { useEffect, useState } from "react";

export interface UseWhiteboardResponsiveReturn {
  /** Wider than tall and under 500px tall: a phone on its side, or a short window. */
  sideways: boolean;
}

/**
 * Whether the board's window is held on its side (see
 * `WhiteboardChromeConfig.sideways`). Where the camera goes when the board
 * changes size is `CameraDirector`'s.
 */
export function useWhiteboardResponsive(): UseWhiteboardResponsiveReturn {
  const [sideways, setSideways] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const check = () => {
      setSideways(window.innerWidth > window.innerHeight && window.innerHeight < 500);
    };

    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);

    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  return { sideways };
}

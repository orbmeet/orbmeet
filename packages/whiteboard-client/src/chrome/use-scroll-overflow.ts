import { useCallback, useEffect, useRef, useState } from "react";

export interface ScrollOverflow {
  /** Content is cut off before the scroller's start edge. */
  start: boolean;
  /** Content continues past the scroller's end edge. */
  end: boolean;
}

const NONE: ScrollOverflow = { start: false, end: false };

/**
 * Report which edges of a horizontal scroller are hiding content.
 *
 * The whiteboard toolbar hides its scrollbar on purpose — a scrollbar across a
 * 52px strip of controls looks like damage. The cost is that when the strip
 * does overflow there is no longer anything at all to say so, and the trailing
 * control simply is not there as far as the user can tell. This restores the
 * signal without restoring the scrollbar: callers fade the edge that is hiding
 * something.
 *
 * Chrome is sized so the toolbar fits (`whiteboard-chrome-fit.ts`); this is the
 * backstop for the control sets that still do not, not the primary mechanism.
 */
export function useScrollOverflow<T extends HTMLElement>(): {
  ref: (node: T | null) => void;
  overflow: ScrollOverflow;
} {
  const [overflow, setOverflow] = useState<ScrollOverflow>(NONE);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const ref = useCallback((node: T | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;

    if (!node) {
      setOverflow(NONE);
      return;
    }

    const measure = () => {
      // `scrollLeft` is negative in RTL in some engines; comparing against the
      // rounded magnitude keeps both directions honest.
      const position = Math.abs(node.scrollLeft);
      const maximum = node.scrollWidth - node.clientWidth;
      const next: ScrollOverflow =
        maximum <= 1
          ? NONE
          : { start: position > 1, end: position < maximum - 1 };
      setOverflow((previous) =>
        previous.start === next.start && previous.end === next.end
          ? previous
          : next,
      );
    };

    node.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(node);
    // The content is what changes width when a tool group appears, and it is
    // not the scroller itself — observe the child too.
    const content = node.firstElementChild;
    if (content) observer?.observe(content);
    measure();

    cleanupRef.current = () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  return { ref, overflow };
}

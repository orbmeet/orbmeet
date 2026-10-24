import { useState, useEffect } from "react";

/**
 * Hook to track the on-screen keyboard offset and adjust layout accordingly.
 *
 * On both iOS and Android the soft keyboard shrinks the *visual* viewport
 * without resizing the *layout* viewport (the default `interactive-widget`
 * behavior), so fixed/bottom-anchored inputs end up hidden behind the
 * keyboard. This hook tracks that gap so callers can lift their input above it.
 *
 * Runs on any touch device (coarse pointer), not just iOS — the original
 * iOS-only gate left Android phones with no offset, which is why chat input
 * was unreachable there.
 * 
 * @returns keyboardOffset - The height of the keyboard in pixels (0 when hidden)
 * 
 * @example
 * ```tsx
 * function ChatInput() {
 *   const keyboardOffset = useIOSKeyboard();
 *   
 *   return (
 *     <div
 *       style={{
 *         paddingBottom: keyboardOffset > 0 ? `${keyboardOffset}px` : undefined
 *       }}
 *     >
 *       <input type="text" />
 *     </div>
 *   );
 * }
 * ```
 */
export function useIOSKeyboard(): number {
  const [keyboardOffset, setKeyboardOffset] = useState(0);

  useEffect(() => {
    // Touch devices only — a desktop mouse never raises a soft keyboard, and
    // pinch-zoom there would otherwise be misread as keyboard offset.
    if (typeof window === "undefined") return;
    if (!window.matchMedia?.("(pointer: coarse)").matches) return;

    const vv = window.visualViewport;
    if (!vv) return;

    const onResize = () => {
      // Keyboard height is the layout-viewport space below the visual
      // viewport. Subtracting offsetTop keeps pinch-zoom (which also shrinks
      // vv.height but scrolls the visual viewport down) from being misread
      // as a keyboard.
      const offset = window.innerHeight - vv.height - vv.offsetTop;
      setKeyboardOffset(Math.max(0, offset));
    };

    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);

    // Call once to get initial state
    onResize();

    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
    };
  }, []);

  return keyboardOffset;
}

/**
 * Gestures that count as user activation for autoplay and capture. `pointerdown`
 * covers mouse, touch and pen on every engine that matters; `touchend` is the
 * belt to its braces on older WebKit, where activation is granted on touch end
 * rather than start. Capture phase so a handler that stops propagation cannot
 * hide the gesture from us, and passive so arming this never delays scrolling.
 */
const GESTURE_EVENTS = ["pointerdown", "touchend", "keydown"] as const;

/** Runs `handler` once, inside the next user gesture anywhere on the page. Returns a disposer. */
export function onNextUserGesture(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const fire = () => {
    dispose();
    handler();
  };
  const dispose = () => {
    for (const event of GESTURE_EVENTS) {
      window.removeEventListener(event, fire, { capture: true });
    }
  };

  for (const event of GESTURE_EVENTS) {
    window.addEventListener(event, fire, { capture: true, passive: true });
  }
  return dispose;
}

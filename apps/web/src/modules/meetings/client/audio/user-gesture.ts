/**
 * Events that can carry user activation, the grant autoplay and capture need.
 * Which of them actually does is the HTML spec's "activation-triggering input
 * event", followed by WebKit and Chromium alike: `keydown` other than Escape,
 * `mousedown`, `pointerdown` from a mouse, and for touch and pen only the end
 * of the press — `pointerup` or `touchend`. A touch `pointerdown` carries none:
 * a retry run there is refused, and if it consumed the listener, the
 * `touchend` that follows a moment later — the one that would have worked —
 * found nothing armed. Capture phase so a handler that stops propagation
 * cannot hide the gesture from us, and passive so arming this never delays
 * scrolling.
 */
const GESTURE_EVENTS = ["pointerdown", "pointerup", "touchend", "keydown"] as const;

function isActivationTriggering(event: Event): boolean {
  switch (event.type) {
    case "keydown":
      return (event as KeyboardEvent).key !== "Escape";
    case "pointerdown":
      return (event as PointerEvent).pointerType === "mouse";
    case "pointerup":
      return (event as PointerEvent).pointerType !== "mouse";
    case "touchend":
      return true;
    default:
      return false;
  }
}

/** Runs `handler` once, inside the next user gesture anywhere on the page. Returns a disposer. */
export function onNextUserGesture(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const fire = (event: Event) => {
    if (!isActivationTriggering(event)) return;
    dispose();
    handler();
  };
  const dispose = () => {
    for (const type of GESTURE_EVENTS) {
      window.removeEventListener(type, fire, { capture: true });
    }
  };

  for (const type of GESTURE_EVENTS) {
    window.addEventListener(type, fire, { capture: true, passive: true });
  }
  return dispose;
}

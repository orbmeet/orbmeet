import { useEffect, useRef } from "react";
import { isPullToAddPointerGesture } from "./pull-to-add";
import { useCommittedRef } from "@orbmeet/ui/react";

type PullGestureState = "idle" | "tracking" | "armed" | "committing" | "cooldown";

interface UsePullToAddPageOptions {
  enabled: boolean;
  ready: boolean;
  onAddPage?: () => void;
  idleDelayMs?: number;
  duplicateDelayMs?: number;
  container?: HTMLElement | null;
  /** True while the board is being moved for the reader: the view passing the end is not a pull. */
  isSuppressed?: () => boolean;
}

export function usePullToAddPage({
  enabled,
  ready,
  onAddPage,
  idleDelayMs = 320,
  duplicateDelayMs = 700,
  container,
  isSuppressed,
}: UsePullToAddPageOptions): void {
  const baseReadyRef = useCommittedRef(enabled && ready && !!onAddPage);
  const onAddPageRef = useCommittedRef(onAddPage);
  const lastAddAtRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useCommittedRef(container);
  const isSuppressedRef = useCommittedRef(isSuppressed);
  const gestureStateRef = useRef<PullGestureState>("idle");
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !onAddPage) return;

    const clearIdleTimer = () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };

    const isReadyNow = () =>
      baseReadyRef.current && !isSuppressedRef.current?.();

    const addPageIfReady = () => {
      if (!isReadyNow()) return;
      const now = Date.now();
      if (now - lastAddAtRef.current < duplicateDelayMs) return;
      lastAddAtRef.current = now;
      gestureStateRef.current = "committing";
      clearIdleTimer();
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
      onAddPageRef.current?.();
      gestureStateRef.current = "cooldown";
      cooldownTimerRef.current = setTimeout(() => {
        if (gestureStateRef.current === "cooldown") {
          gestureStateRef.current = "idle";
        }
        cooldownTimerRef.current = null;
      }, duplicateDelayMs);
    };

    const scheduleIdleAdd = () => {
      if (!isReadyNow()) return;
      clearIdleTimer();
      idleTimerRef.current = setTimeout(addPageIfReady, idleDelayMs);
    };

    const markPointerInput = (e: Event) => {
      const c = containerRef.current;
      const onCanvas = !c || c.contains(e.target as Node);
      if (!onCanvas) {
        gestureStateRef.current = "idle";
        pointerStartRef.current = null;
        return;
      }
      if (gestureStateRef.current !== "cooldown") {
        gestureStateRef.current = "tracking";
      }
      const isTouch = typeof TouchEvent !== "undefined" && e instanceof TouchEvent;
      const isPointer = typeof PointerEvent !== "undefined" && e instanceof PointerEvent;
      if (isPointer || isTouch) {
        const point = isTouch ? e.touches[0] : (e as PointerEvent);
        if (!point) return;
        pointerStartRef.current = { x: point.clientX, y: point.clientY };
      }
    };
    const markPointerMove = (e: Event) => {
      if (gestureStateRef.current !== "tracking" || !pointerStartRef.current) return;
      const isTouch = typeof TouchEvent !== "undefined" && e instanceof TouchEvent;
      const isPointer = typeof PointerEvent !== "undefined" && e instanceof PointerEvent;
      if (!isPointer && !isTouch) return;
      const point = isTouch ? e.touches[0] : (e as PointerEvent);
      if (!point) return;
      const dx = point.clientX - pointerStartRef.current.x;
      const dy = point.clientY - pointerStartRef.current.y;
      if (isPullToAddPointerGesture(dx, dy) && isReadyNow()) {
        gestureStateRef.current = "armed";
      }
    };
    const markWheelInput = (e: Event) => {
      const c = containerRef.current;
      const onCanvas = !c || c.contains(e.target as Node);
      if (!onCanvas) return;
      if (typeof WheelEvent !== "undefined" && e instanceof WheelEvent && e.deltaY <= 0) return;
      if (isReadyNow() && gestureStateRef.current !== "cooldown") {
        gestureStateRef.current = "armed";
        scheduleIdleAdd();
      }
    };
    const handleRelease = () => {
      const state = gestureStateRef.current;
      pointerStartRef.current = null;
      if (state === "armed") {
        addPageIfReady();
      } else if (state !== "cooldown" && state !== "committing") {
        gestureStateRef.current = "idle";
      }
    };
    const handleCancel = () => {
      pointerStartRef.current = null;
      if (gestureStateRef.current !== "cooldown" && gestureStateRef.current !== "committing") {
        gestureStateRef.current = "idle";
      }
    };

    window.addEventListener("pointerdown", markPointerInput, true);
    window.addEventListener("touchstart", markPointerInput, true);
    window.addEventListener("pointermove", markPointerMove, true);
    window.addEventListener("touchmove", markPointerMove, true);
    window.addEventListener("pointerup", handleRelease, true);
    window.addEventListener("pointercancel", handleCancel, true);
    window.addEventListener("touchend", handleRelease, true);
    window.addEventListener("touchcancel", handleCancel, true);
    window.addEventListener("wheel", markWheelInput, { capture: true, passive: true });

    return () => {
      clearIdleTimer();
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
      pointerStartRef.current = null;
      gestureStateRef.current = "idle";
      window.removeEventListener("pointerdown", markPointerInput, true);
      window.removeEventListener("touchstart", markPointerInput, true);
      window.removeEventListener("pointermove", markPointerMove, true);
      window.removeEventListener("touchmove", markPointerMove, true);
      window.removeEventListener("pointerup", handleRelease, true);
      window.removeEventListener("pointercancel", handleCancel, true);
      window.removeEventListener("touchend", handleRelease, true);
      window.removeEventListener("touchcancel", handleCancel, true);
      window.removeEventListener("wheel", markWheelInput, true);
    };
  }, [
    baseReadyRef,
    containerRef,
    duplicateDelayMs,
    enabled,
    idleDelayMs,
    onAddPage,
    onAddPageRef,
    isSuppressedRef,
  ]);
}

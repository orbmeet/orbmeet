const INSTALL_KEY = "__orbmeetCanvasTransformGuardInstalled";

declare global {
  interface Window {
    [INSTALL_KEY]?: boolean;
  }
}

function isCanvasMaxSizeError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.message.toLowerCase().includes("canvas exceeds max size")
  );
}

export function installCanvasTransformGuard(): void {
  if (typeof window === "undefined") return;
  if (window[INSTALL_KEY]) return;

  const proto = window.CanvasRenderingContext2D?.prototype;
  if (!proto?.setTransform) return;

  const originalSetTransform = proto.setTransform;
  proto.setTransform = function guardedSetTransform(
    this: CanvasRenderingContext2D,
    ...args: Parameters<CanvasRenderingContext2D["setTransform"]>
  ) {
    try {
      return originalSetTransform.apply(this, args);
    } catch (error) {
      if (isCanvasMaxSizeError(error)) {
        if (this.canvas.closest("[data-orbmeet-whiteboard-canvas]")) return undefined;
      }
      throw error;
    }
  } as CanvasRenderingContext2D["setTransform"];

  window[INSTALL_KEY] = true;
}

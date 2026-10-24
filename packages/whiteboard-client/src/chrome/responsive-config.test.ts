import { describe, expect, it } from "vitest";
import {
  calculateCameraPadding,
  getResponsiveConfig,
  getViewportCategory,
} from "./responsive-config";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";

describe("whiteboard responsive config", () => {
  it("keeps an 11-inch iPad class viewport on tablet camera settings", () => {
    expect(getViewportCategory({ width: 820, height: 1180 })).toBe("tablet");
    expect(getViewportCategory({ width: 1180, height: 820 })).toBe("tablet");

    const config = getResponsiveConfig({ width: 1180, height: 820 });
    expect(config.page.width).toBe(WHITEBOARD_CONFIG.PAGE_WIDTH);
    expect(config.page.height).toBe(WHITEBOARD_CONFIG.PAGE_HEIGHT);
    expect(config.cameraPadding).toBe(
      Math.max(24, Math.round(WHITEBOARD_CONFIG.CAMERA_PADDING * 0.75))
    );
  });

  it("uses compact camera padding for Android/iPhone-sized landscape screens", () => {
    expect(getViewportCategory({ width: 915, height: 412 })).toBe(
      "mobile-landscape"
    );
    expect(calculateCameraPadding({ width: 915, height: 412 })).toBe(
      Math.max(16, Math.round(WHITEBOARD_CONFIG.CAMERA_PADDING * 0.5))
    );
  });

  it("uses desktop camera padding on laptop and desktop viewports", () => {
    expect(getViewportCategory({ width: 1366, height: 768 })).toBe("desktop");
    expect(getViewportCategory({ width: 2560, height: 1440 })).toBe("desktop");
    expect(calculateCameraPadding({ width: 1366, height: 768 })).toBe(
      WHITEBOARD_CONFIG.CAMERA_PADDING
    );
  });
});

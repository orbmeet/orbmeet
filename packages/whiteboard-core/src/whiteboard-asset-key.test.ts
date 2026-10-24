import { describe, expect, it } from "vitest";
import {
  buildWhiteboardAssetApiPath,
  buildWhiteboardPdfImportAssetKey,
  buildWhiteboardAssetViewerUrl,
  buildWhiteboardDocumentAssetKey,
  extractWhiteboardDocumentAssetIdentity,
  extractWhiteboardAssetKeyFromViewerUrl,
} from "./whiteboard-asset-key.ts";

describe("whiteboard asset key helpers", () => {
  it("builds whiteboard asset viewer URLs", () => {
    expect(
      buildWhiteboardAssetApiPath("whiteboards/whiteboard_1/assets/whiteboard_asset_1.png"),
    ).toBe("/api/wb-assets/whiteboards/whiteboard_1/assets/whiteboard_asset_1.png");

    expect(
      buildWhiteboardAssetViewerUrl("whiteboards/whiteboard_1/assets/whiteboard_asset_1.png"),
    ).toBe("/api/wb-assets/whiteboards/whiteboard_1/assets/whiteboard_asset_1.png");

    expect(
      buildWhiteboardAssetViewerUrl(
        "/api/wb-assets/whiteboards/whiteboard_1/assets/file.png",
        "whiteboard_1",
      ),
    ).toBe(
      "/api/wb-assets/whiteboards/whiteboard_1/assets/file.png?whiteboardId=whiteboard_1",
    );

    expect(buildWhiteboardAssetViewerUrl("https://example.com/file.png")).toBe("");
  });

  it("refuses every source a browser would resolve against another origin", () => {
    // `//example.invalid/pixel` starts with `/`, so the same-origin path branch
    // used to hand it back unchanged and the browser resolved it against the
    // page's protocol — a persisted, peer-controlled source becoming a fetch.
    for (const src of [
      "//example.invalid/pixel",
      "\n//example.invalid/pixel",
      "\\\\example.invalid\\pixel",
      "/\\\\example.invalid/pixel",
      "http://example.invalid/pixel",
      "https://example.invalid/pixel",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "  data:text/html,<script>",
    ]) {
      expect(buildWhiteboardAssetViewerUrl(src)).toBe("");
    }

    // The two sources the canvas legitimately produces still pass through.
    expect(buildWhiteboardAssetViewerUrl("blob:https://app.test/abc")).toBe(
      "blob:https://app.test/abc",
    );
    expect(buildWhiteboardAssetViewerUrl("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("refuses an asset key segment that would rewrite the object's prefix", () => {
    for (const assetId of ["../../other", "a/b", "..", "", "a\u0000b"]) {
      expect(() => buildWhiteboardDocumentAssetKey("whiteboard_1", assetId, "png")).toThrow(
        /Invalid whiteboard asset key/,
      );
    }
    expect(() => buildWhiteboardDocumentAssetKey("../evil", "asset_1", "png")).toThrow();
    expect(() => buildWhiteboardDocumentAssetKey("whiteboard_1", "asset_1", "png/x")).toThrow();
  });

  it("builds and parses document-owned asset keys", () => {
    const key = buildWhiteboardDocumentAssetKey(
      "whiteboard_1",
      "whiteboard_asset_1",
      "png",
    );
    expect(key).toBe(
      "whiteboards/whiteboard_1/assets/whiteboard_asset_1.png",
    );
    expect(extractWhiteboardDocumentAssetIdentity(key)).toEqual({
      whiteboardId: "whiteboard_1",
    });
    expect(extractWhiteboardDocumentAssetIdentity(
      "uploads/usr_1/wb/meeting_1/file.png",
    )).toBeNull();
  });

  it("extracts storage keys from viewer URLs", () => {
    expect(
      extractWhiteboardAssetKeyFromViewerUrl(
        "/api/wb-assets/whiteboards/whiteboard_1/assets/file%20name.png?v=abc",
      ),
    ).toBe("whiteboards/whiteboard_1/assets/file name.png");

    expect(
      extractWhiteboardAssetKeyFromViewerUrl(
        "https://orbmeet.com/api/wb-assets/whiteboards/whiteboard_1/assets/file.png",
      ),
    ).toBe("whiteboards/whiteboard_1/assets/file.png");

    expect(extractWhiteboardAssetKeyFromViewerUrl("https://example.com/file.png")).toBeNull();
    expect(extractWhiteboardAssetKeyFromViewerUrl("/api/wb-assets/uploads/usr_1/../secret")).toBeNull();
    expect(extractWhiteboardAssetKeyFromViewerUrl("/api/wb-assets/uploads/usr_1/.%2e/secret")).toBeNull();
    expect(extractWhiteboardAssetKeyFromViewerUrl("/api/wb-assets/uploads/usr_1/%252e%252e/secret")).toBeNull();
    expect(extractWhiteboardAssetKeyFromViewerUrl("/api/wb-assets/uploads\\usr_1\\secret")).toBeNull();
  });

  it("puts a PDF import's pages under the import's own prefix", () => {
    const importId = "c9269fa1-63a2-4960-8a13-f54c681892e0";
    expect(buildWhiteboardPdfImportAssetKey("wb_1", importId, 3))
      .toBe(`whiteboards/wb_1/assets/imports/${importId}/page-3.png`);
  });
});

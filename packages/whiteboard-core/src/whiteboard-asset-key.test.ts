import { describe, expect, it } from "vitest";
import {
  buildWhiteboardAssetApiPath,
  buildWhiteboardPdfImportAssetKey,
  buildWhiteboardAssetViewerUrl,
  buildWhiteboardDocumentAssetKey,
  extractWhiteboardDocumentAssetIdentity,
  whiteboardAssetKeyOfSrc,
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

  it("reads the object a source names only in the forms the app writes", () => {
    const key = "whiteboards/whiteboard_1/assets/file.png";
    expect(whiteboardAssetKeyOfSrc(key)).toBe(key);
    expect(whiteboardAssetKeyOfSrc(`/api/wb-assets/${key}`)).toBe(key);
    expect(whiteboardAssetKeyOfSrc("/api/wb-assets/whiteboards/wb_1/assets/imports/c9269fa1-63a2/page-3.png"))
      .toBe("whiteboards/wb_1/assets/imports/c9269fa1-63a2/page-3.png");

    for (const src of [
      `${key}?v=1`,
      `/api/wb-assets/${key}#frag`,
      "whiteboards%2Fwhiteboard_1%2Fassets%2Ffile.png",
      "/api/wb-assets/whiteboards/whiteboard_1/assets/file%20name.png",
      "https://orbmeet.com/api/wb-assets/whiteboards/whiteboard_1/assets/file.png",
      "whiteboards/whiteboard_1/assets/../../whiteboard_2/assets/file.png",
      "whiteboards/whiteboard_1/assets/",
      "whiteboards//assets/file.png",
      "uploads/usr_1/secret.png",
      "/api/wb-assets/uploads\\usr_1\\secret",
    ]) {
      expect(whiteboardAssetKeyOfSrc(src)).toBeNull();
    }
  });

  it("loads in the viewer exactly the object the source names, or nothing", () => {
    // What the sync server admits, the revision pins and the viewer loads
    // must be one object: a source one of them reads differently is refused.
    for (const src of [
      "whiteboards/whiteboard_1/assets/file.png?v=1",
      "/api/wb-assets/whiteboards/whiteboard_1/assets/file.png#frag",
      "whiteboards%2Fwhiteboard_1%2Fassets%2Ffile.png",
      "/some/other/path.png",
    ]) {
      expect(buildWhiteboardAssetViewerUrl(src, "whiteboard_1")).toBe("");
    }
  });

  it("puts a PDF import's pages under the import's own prefix", () => {
    const importId = "c9269fa1-63a2-4960-8a13-f54c681892e0";
    expect(buildWhiteboardPdfImportAssetKey("wb_1", importId, 3))
      .toBe(`whiteboards/wb_1/assets/imports/${importId}/page-3.png`);
  });
});

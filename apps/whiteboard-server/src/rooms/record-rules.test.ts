import { describe, expect, it } from "vitest";
import { isSafeExternalBrowserUrl } from "@orbmeet/whiteboard-core/public-host";
import { describeAssetSources, hasUnsafeUrl, isAllowedAsset, isPageFrameRecord } from "./record-rules.ts";

const BOARD = "whiteboard_1";
const OWN_ASSET = `/api/wb-assets/whiteboards/${BOARD}/assets/whiteboard_asset_1.png`;

const image = (src: unknown) => ({ type: "image", props: { src, w: 1, h: 1, name: "a.png", isAnimated: false, mimeType: "image/png" } });
const bookmark = (props: Record<string, unknown>) => ({ type: "bookmark", props: { src: "https://example.test/article", ...props } });

describe("isAllowedAsset", () => {
  it("allows media from the board's own storage, and the null source of an unresolved upload", () => {
    expect(isAllowedAsset(image(OWN_ASSET), BOARD)).toBe(true);
    expect(isAllowedAsset(image(null), BOARD)).toBe(true);
    expect(isAllowedAsset(image(""), BOARD)).toBe(true);
  });

  it.each([
    ["an external tracker", "https://tracker.example/pixel.png"],
    ["a data url", "data:image/svg+xml,<svg></svg>"],
    ["the retired meeting-keyed layout", "/api/wb-assets/uploads/user-1/wb/mtg_123/file.png"],
    ["a key that only contains /wb/ below an unrelated prefix", "/api/wb-assets/uploads/user-1/anything/else/wb/mtg_123/file.png"],
    ["encoded traversal", "/api/wb-assets/uploads/user-1/wb/mtg_123/%2e%2e/secret.png"],
    ["encoded traversal in a document-scoped path", `/api/wb-assets/whiteboards/${BOARD}/assets/whiteboard_asset_1/%2e%2e/secret.png`],
    ["another board's asset", "/api/wb-assets/whiteboards/whiteboard_other/assets/secret.png"],
  ])("refuses media from %s", (_label, src) => {
    expect(isAllowedAsset(image(src), BOARD)).toBe(false);
  });

  it("cannot vouch for a board's own media without knowing which board it is", () => {
    expect(isAllowedAsset(image(OWN_ASSET), undefined)).toBe(false);
  });

  it("allows a bookmark to public hosts, and the blanked source the editor writes for one it will not preview", () => {
    expect(isAllowedAsset(bookmark({
      image: "https://cdn.example.test/preview.png",
      favicon: "https://example.test/favicon.ico",
      title: "Example",
      description: "Example",
    }), BOARD)).toBe(true);
    expect(isAllowedAsset(bookmark({ src: "", image: "", favicon: "", title: "localhost", description: "" }), BOARD)).toBe(true);
  });

  // The editor pre-checks a pasted url with the same predicate and blanks
  // `src` when it refuses it, so the two must agree.
  it.each([
    "http://localhost:3000/dev",
    "http://127.0.0.1/admin",
    "http://192.168.1.5/router",
    "http://[::1]/x",
    "http://printer.local/status",
  ])("agrees with the client that %s cannot be a bookmark source", (url) => {
    expect(isSafeExternalBrowserUrl(url)).toBe(false);
    expect(isAllowedAsset(bookmark({ src: url }), BOARD)).toBe(false);
  });

  it.each([
    ["http://2130706433/preview.png", "integer-form 127.0.0.1"],
    ["http://0x7f.0.0.1/preview.png", "hex-dotted 127.0.0.1"],
    ["http://[::ffff:127.0.0.1]/preview.png", "IPv4-mapped loopback"],
    ["http://[::ffff:10.0.0.5]/preview.png", "IPv4-mapped private"],
    ["http://0.1.2.3/preview.png", "0.0.0.0/8"],
    ["http://100.64.1.1/preview.png", "CGNAT 100.64/10"],
    ["http://intranet/preview.png", "single-label host"],
  ])("refuses bookmark preview media at %s (%s)", (url) => {
    expect(isAllowedAsset(bookmark({ image: url }), BOARD)).toBe(false);
    expect(isAllowedAsset(bookmark({ favicon: url }), BOARD)).toBe(false);
  });

  it("bounds bookmark text a third-party page supplied", () => {
    expect(isAllowedAsset(bookmark({ title: "x".repeat(100_000) }), BOARD)).toBe(false);
    expect(isAllowedAsset(bookmark({ description: { text: "not a string" } }), BOARD)).toBe(false);
  });
});

describe("hasUnsafeUrl", () => {
  it.each(["embed", "image", "video", "bookmark", "some-future-shape"])(
    "holds a %s shape's url to the public-host policy",
    (type) => {
      expect(hasUnsafeUrl({ type, props: { url: "http://169.254.169.254/latest/meta-data/" } })).toBe(true);
      expect(hasUnsafeUrl({ type, props: { url: "javascript:alert(1)" } })).toBe(true);
    },
  );

  it("allows a public url and the empty url tldraw seeds shapes with", () => {
    expect(hasUnsafeUrl({ props: { url: "https://example.com/page" } })).toBe(false);
    expect(hasUnsafeUrl({ props: { url: "" } })).toBe(false);
  });

  it("finds a url anywhere in the record, judged as written whatever its shape", () => {
    expect(hasUnsafeUrl({ meta: { url: "http://10.0.0.1/internal" } })).toBe(true);
    expect(hasUnsafeUrl({ meta: { nested: [{ url: "http://10.0.0.1/internal" }] } })).toBe(true);
    expect(hasUnsafeUrl({ props: { url: { href: "https://example.com" } } })).toBe(true);
  });
});

describe("describeAssetSources", () => {
  it("names the kind of each source, never the source itself", () => {
    expect(describeAssetSources(image("data:image/svg+xml,<svg></svg>"), BOARD)).toBe("src:data-url");
    expect(describeAssetSources(image(OWN_ASSET), BOARD)).toBe("src:whiteboard-storage");
    expect(describeAssetSources(image(OWN_ASSET), undefined)).toBe("src:invalid-whiteboard-path");
    expect(describeAssetSources(bookmark({ favicon: "https://x.test/f.ico" }), BOARD)).toBe("src:external-http,favicon:external-http");
  });
});

describe("isPageFrameRecord", () => {
  it("knows a page frame by its shape type", () => {
    expect(isPageFrameRecord({ typeName: "shape", type: "whiteboard-page" })).toBe(true);
    expect(isPageFrameRecord({ typeName: "shape", type: "frame" })).toBe(false);
    expect(isPageFrameRecord({ typeName: "asset", type: "whiteboard-page" })).toBe(false);
  });
});

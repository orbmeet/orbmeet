import { readFile } from "node:fs/promises";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { WB_ASSET_URLS } from "@orbmeet/whiteboard-client/react";
import {
  WHITEBOARD_ASSET_URLS,
  WhiteboardTldraw,
} from "@/modules/whiteboards/client/surface/whiteboard-canvas";

describe("whiteboard canvas client boundary", () => {
  it("enforces Orb Meet's canvas class and self-hosted assets", () => {
    const element = WhiteboardTldraw({ className: "preview" });

    expect(isValidElement(element)).toBe(true);
    const props = (element as ReactElement<{
      assetUrls: typeof WB_ASSET_URLS;
      className: string;
    }>).props;
    expect(props.className.split(" ")).toContain("whiteboard-document");
    expect(props.className.split(" ")).toContain("preview");
    expect(props.assetUrls).toBe(WB_ASSET_URLS);
    expect(WHITEBOARD_ASSET_URLS).toBe(WB_ASSET_URLS);
    const { tldraw_draw, tldraw_draw_bold, tldraw_draw_italic, tldraw_draw_italic_bold, ...engineFonts } =
      WB_ASSET_URLS.fonts;
    expect(
      // Self-hosted, under the tldraw version's directory.
      Object.values(engineFonts).every((url) =>
        /^\/wb-assets\/\d+\.\d+\.\d+[^/]*\/fonts\//.test(url),
      ),
    ).toBe(true);
    // Typed text is Source Serif 4, served with the app's own fonts.
    expect([tldraw_draw, tldraw_draw_bold]).toEqual([
      "/fonts/source-serif-4.woff2",
      "/fonts/source-serif-4.woff2",
    ]);
    expect([tldraw_draw_italic, tldraw_draw_italic_bold]).toEqual([
      "/fonts/source-serif-4-italic.woff2",
      "/fonts/source-serif-4-italic.woff2",
    ]);
  });

  it("loads tldraw CSS before Orb Meet's canvas overrides", async () => {
    const source = await readFile(
      new URL("./whiteboard-canvas.tsx", import.meta.url),
      "utf8",
    );
    const tldrawCss = source.indexOf('import "tldraw/tldraw.css"');
    const orbmeetCss = source.indexOf(
      'import "@orbmeet/whiteboard-client/styles.css"',
    );

    expect(tldrawCss).toBeGreaterThanOrEqual(0);
    expect(orbmeetCss).toBeGreaterThan(tldrawCss);
  });

  it("keeps standalone preview mounts behind the configured wrapper", async () => {
    // Read-only previews of captured content. The Whiteboard document route is
    // no longer one of these: it mounts the live editor, not a preview.
    const previewConsumers = [
      new URL("../../../../pages/meeting-summary/components/whiteboard-pdf-panel.tsx", import.meta.url),
    ];

    for (const consumer of previewConsumers) {
      const source = await readFile(consumer, "utf8");
      expect(source).toContain("WhiteboardTldraw");
      expect(source).not.toMatch(/<Tldraw(?:\s|>)/);
    }
  });

  it("configures the live standalone canvas with styles and self-hosted assets", async () => {
    const source = await readFile(
      new URL("../../../../pages/whiteboards/whiteboard-document-page.tsx", import.meta.url),
      "utf8",
    );

    // Importing from the configured canvas boundary loads both required
    // stylesheets; passing the exported URLs keeps tldraw off its font CDN.
    expect(source).toContain(
      'import { WHITEBOARD_ASSET_URLS } from "@/modules/whiteboards/client/surface/whiteboard-canvas"',
    );
    expect(source).toContain("assetUrls={WHITEBOARD_ASSET_URLS}");
  });

  it("never mounts bare tldraw outside the configured wrapper", async () => {
    // The rule the roster above exists to protect, applied to every canvas
    // consumer regardless of whether it previews or edits.
    const whiteboardConsumers = [
      new URL("../../../../pages/meeting-summary/components/whiteboard-pdf-panel.tsx", import.meta.url),
      new URL("../../../../pages/whiteboards/whiteboard-document-page.tsx", import.meta.url),
    ];

    for (const consumer of whiteboardConsumers) {
      const source = await readFile(consumer, "utf8");
      expect(source).not.toMatch(/<Tldraw(?:\s|>)/);
    }
  });
});

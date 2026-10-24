import { getAssetUrls } from "@tldraw/assets/selfHosted.js";
import assetsPackage from "@tldraw/assets/package.json" with { type: "json" };

/**
 * The whiteboard engine's fonts, icons and translations, served by apps/web
 * from its own origin (scripts/setup-assets.mjs copies @tldraw/assets there).
 * The version is part of every URL, so a URL always names the same bytes.
 */
const engineAssetUrls = getAssetUrls({ baseUrl: `/wb-assets/${assetsPackage.version}` });

/**
 * Source Serif 4 (OFL), served with the app like Figtree and Geist Mono: a
 * roman and an italic, each one variable face from 400 to 700, optical size
 * fixed at text size, subset to Latin, Latin Extended and Greek.
 */
const SOURCE_SERIF = "/fonts/source-serif-4.woff2";
const SOURCE_SERIF_ITALIC = "/fonts/source-serif-4-italic.woff2";

/**
 * Typed text is set in Source Serif 4 instead of tldraw's handwriting face.
 * A sentence typed with T sits next to KaTeX's serif math, and handwriting
 * beside it read as two voices on one line.
 *
 * tldraw's `draw` style is the one every text shape already stores, so the
 * face is swapped at its source rather than adding a font style: old boards
 * change with new ones, with no migration. These URLs are what tldraw both
 * renders and measures with, and what it embeds in an export, so the three
 * cannot disagree. Bold is the same variable file at weight 700.
 */
export const WB_ASSET_URLS = {
  ...engineAssetUrls,
  fonts: {
    ...engineAssetUrls.fonts,
    tldraw_draw: SOURCE_SERIF,
    tldraw_draw_bold: SOURCE_SERIF,
    tldraw_draw_italic: SOURCE_SERIF_ITALIC,
    tldraw_draw_italic_bold: SOURCE_SERIF_ITALIC,
  },
};

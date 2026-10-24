import type { ComponentProps } from "react";

// Keep the editor's structural CSS and Orb Meet overrides in the same lazy
// client boundary. Every standalone canvas must load both before tldraw can
// safely measure or resize its overlay whiteboards.
import "tldraw/tldraw.css";
import "@orbmeet/whiteboard-client/styles.css";

import { Tldraw } from "@orbmeet/whiteboard-client/react";
import { WB_ASSET_URLS } from "@orbmeet/whiteboard-client/react";
import * as stylex from "@stylexjs/stylex";
import { surface } from "@orbmeet/ui/tokens/colors.stylex";

export const WHITEBOARD_ASSET_URLS = WB_ASSET_URLS;

type WhiteboardTldrawProps = ComponentProps<typeof Tldraw>;

const styles = stylex.create({
  document: {
    position: "relative",
    touchAction: "none",
    /**
     * Declared, not just read. `whiteboard-canvas.css` paints the tldraw
     * layers from `--wb-document-bg`, and a static stylesheet cannot name a
     * hashed StyleX variable — so publishing it here is what keeps the
     * standalone board on the same themeable token as the meeting board (see
     * `synced-whiteboard.tsx`), rather than on the stylesheet's literal.
     */
    "--wb-document-bg": surface.board,
    backgroundColor: "var(--wb-document-bg)",
    // Paper on a desk in every theme: the board, its toolbar and its page rail
    // stay light even when the room around them is dark, so a drawing looks
    // the same to everyone in it.
    colorScheme: "light",
  },
});

/**
 * Standalone tldraw canvas with Orb Meet's required styles and self-hosted
 * fonts/icons. Live Meeting whiteboards share the same assets through the export
 * above while retaining their richer SyncedWhiteboard.
 */
export function WhiteboardTldraw({ className, ...props }: WhiteboardTldrawProps) {
  const documentClass = stylex.props(styles.document).className;
  return (
    <Tldraw
      {...props}
      className={["whiteboard-document", documentClass, className].filter(Boolean).join(" ")}
      assetUrls={WHITEBOARD_ASSET_URLS}
    />
  );
}

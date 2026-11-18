import { useMemo } from "react";
import type { TLAssetStore } from "tldraw";
import {
  roomSnapshotToStoreSnapshot,
  WHITEBOARD_TLDRAW_OPTIONS,
  whiteboardShapeUtils,
} from "@orbmeet/whiteboard-client/react";
import { WhiteboardTldraw } from "@/modules/whiteboards/client/surface/whiteboard-canvas";

/** A meeting's board on the handoff page, read-only. */
export function HandoffBoard({
  snapshot,
  assets,
}: {
  snapshot: Parameters<typeof roomSnapshotToStoreSnapshot>[0];
  assets: TLAssetStore;
}) {
  const storeSnapshot = useMemo(() => roomSnapshotToStoreSnapshot(snapshot), [snapshot]);
  return (
    <WhiteboardTldraw
      snapshot={storeSnapshot}
      assets={assets}
      shapeUtils={whiteboardShapeUtils}
      onMount={(editor) => {
        // The whole board in view, as the host's recap shows it: opened at
        // the camera's origin, a phone showed one box of a flowchart.
        const bounds = editor.getCurrentPageBounds();
        if (bounds) editor.zoomToBounds(bounds, { inset: 16 });
        editor.updateInstanceState({ isReadonly: true });
      }}
      options={WHITEBOARD_TLDRAW_OPTIONS}
      licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
    />
  );
}

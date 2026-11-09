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
        editor.updateInstanceState({ isReadonly: true });
      }}
      options={WHITEBOARD_TLDRAW_OPTIONS}
      licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
    />
  );
}

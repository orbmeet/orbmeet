import { useCallback, useEffect, useRef } from "react";
import type {
  TLAnyBindingUtilConstructor,
  TLAnyShapeUtilConstructor,
  TLAssetStore,
  TLPresenceStateInfo,
  TLStore,
  TLUser,
  TLUserStore,
} from "tldraw";
import { useSync } from "@tldraw/sync";
import type { CustomRecordInfo } from "@tldraw/tlschema";
import {
  WhiteboardWebSocketAdapter,
  type WhiteboardConnectAttempt,
} from "./whiteboard-socket-adapter";

/**
 * Pre-configured asset store that doesn't upload.
 * Useful for read-only or ephemeral whiteboards.
 *
 * `upload` returns an empty src intentionally — images dropped onto a
 * read-only whiteboard are silently discarded rather than uploaded.
 */
const NoopAssetStore: TLAssetStore = {
  upload: async (_asset, _file, _abortSignal) => ({ src: "" }),
  resolve: (asset, _ctx) => asset.props.src ?? null,
};

/**
 * Sync store hook options
 */
export interface UseWhiteboardSyncOptions {
  uri: string | ((attempt: WhiteboardConnectAttempt) => string | Promise<string>);
  assets?: TLAssetStore;
  shapeUtils?: readonly TLAnyShapeUtilConstructor[];
  bindingUtils?: readonly TLAnyBindingUtilConstructor[];
  /** The room's own record types beside tldraw's; must be the schema the room validates by. */
  records?: Record<string, CustomRecordInfo>;
  users?: TLUserStore;
  /**
   * What this client broadcasts as its presence, or `null` to broadcast none.
   * Runs inside a reactive derivation, so anything it reads must be a signal.
   */
  getUserPresence?: (store: TLStore, user: TLUser) => TLPresenceStateInfo | null;
  onCustomMessageReceived?: (data: unknown) => void;
}

/**
 * Hook to connect to the whiteboard server.
 * Wraps @tldraw/sync's useSync with our server protocol.
 */
export function useWhiteboardSync(options: UseWhiteboardSyncOptions) {
  // When users isn't available yet (async dynamic imports haven't resolved),
  // use a URI function that never resolves. This prevents useSync from opening
  // a WebSocket before the user identity is known. Without this, useSync would
  // open a connection with users=undefined, then immediately tear it down when
  // users becomes available (producing "WebSocket is closed before the
  // connection is established" errors). By blocking the URI, the first
  // connection attempt never opens; when users arrives both uri and users
  // change together and useSync creates a single clean connection.
  const pendingUri = useCallback(
    () => new Promise<string>(() => {}),
    []
  );
  // URI factories are commonly closures over a freshly minted token and are
  // naturally recreated by a host render. They are reconnect inputs, not store
  // identity: keep the adapter stable and let its next connection attempt read
  // the latest committed factory. `users` still goes to useSync directly, so a
  // real identity-store change continues to rebuild the tldraw store as needed.
  const uriRef = useRef(options.uri);
  const usersReadyRef = useRef(Boolean(options.users));
  useEffect(() => {
    uriRef.current = options.uri;
    usersReadyRef.current = Boolean(options.users);
  }, [options.uri, options.users]);
  const connect = useCallback(
    (query: { sessionId: string; storeId: string }) =>
      new WhiteboardWebSocketAdapter(
        (attempt) => {
          const uri = usersReadyRef.current ? uriRef.current : pendingUri;
          return typeof uri === "string" ? uri : uri(attempt);
        },
        query,
      ),
    [pendingUri],
  );

  return useSync({
    connect,
    assets: options.assets ?? NoopAssetStore,
    shapeUtils: options.shapeUtils,
    bindingUtils: options.bindingUtils,
    records: options.records,
    users: options.users,
    getUserPresence: options.getUserPresence,
    onCustomMessageReceived: options.onCustomMessageReceived,
  });
}
